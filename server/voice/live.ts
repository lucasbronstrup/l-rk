/**
 * Modo de voz ao vivo: ponte WebSocket entre o navegador e o Gemini Live.
 *
 * Protocolo com o cliente (ver `VoiceClientMessage`/`VoiceServerMessage` em shared/types.ts):
 *  - binário cliente → servidor: PCM16 mono 16 kHz do microfone (repassado ao Gemini);
 *  - binário servidor → cliente: PCM16 mono 24 kHz da voz do Lärk;
 *  - JSON nos dois sentidos para controle, transcrições, ferramentas e fim de turno.
 *
 * Cada conexão mantém no máximo uma sessão Live. A sessão usa a voz e a persona do Lärk,
 * as ferramentas (memória, computador, web), transcrição de entrada e saída, compressão da janela
 * de contexto e retomada de sessão: em `goAway` ou queda, reconecta de forma transparente com o
 * último handle (ou recomeça com o contexto reconstruído do banco). Cada turno concluído vira
 * mensagens salvas (kind 'voice') e dispara o pós-turno (extração de memórias/compromissos).
 */
import os from 'node:os';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  EndSensitivity,
  Modality,
  type FunctionCall,
  type FunctionDeclaration,
  type FunctionResponse,
  type LiveConnectConfig,
  type LiveServerContent,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import {
  GeminiError,
  classifyGeminiError,
  getClient,
  getModelFallbacks,
  isRetryableModelError,
  reportModelFailure,
  resolveModel,
} from '../llm/gemini.js';
import { getToolDeclarations, runTool } from '../tools/index.js';
import { addMessage, listMessages } from '../memory/messages.js';
import { getConversation, getOrCreateActiveConversation } from '../memory/conversations.js';
import { getSettings } from '../memory/settings.js';
import { buildSystemInstruction } from '../agent/context.js';
import { VOICE_DIRECTION } from '../agent/persona.js';
import { schedulePostTurn } from '../agent/post-turn.js';
import { DEFAULT_VOICE, resolveVoiceName } from './voices.js';
import type { ChatMessage, Settings, ToolCallInfo, VoiceServerMessage } from '../../shared/types.js';

// ─── Parâmetros ──────────────────────────────────────────────────────────

export const VOICE_PATH = '/api/voice';
const INPUT_MIME = 'audio/pcm;rate=16000';
const PING_INTERVAL_MS = 20_000;
/** Tempo máximo para o Gemini concluir o setup de uma sessão (o cliente desiste em 10 s). */
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_MODEL_ATTEMPTS = 3;
const MAX_CONNECTIONS = 4;
const MAX_WS_PAYLOAD = 1024 * 1024;
const MAX_JSON_CHARS = 64 * 1024;
const MAX_AUDIO_FRAME_BYTES = 256 * 1024;
/** Áudio guardado enquanto a sessão reconecta (~4 s de fala a 16 kHz). */
const MAX_PENDING_AUDIO_BYTES = 16_000 * 2 * 4;
const MAX_PENDING_OPS = 50;
const MAX_PENDING_TEXTS = 5;
const MAX_TEXT_CHARS = 4_000;
/** Acima disso o cliente não está dando conta de tocar: descarta áudio em vez de acumular. */
const MAX_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_RESUME_ATTEMPTS = 3;
const MAX_RECONNECTS_PER_CONNECTION = 30;
const RESUME_BACKOFF_MS = 600;
const RECENT_HISTORY_MESSAGES = 14;
const RECENT_HISTORY_CHARS = 6_000;

const NO_KEY_MESSAGE =
  'O modo de voz ao vivo precisa da chave gratuita do Google AI Studio. Configure-a em Configurações; enquanto isso, sigo no modo clássico.';
const MOCK_AUDIO_MESSAGE =
  'O Lärk está em modo demonstração: a voz ao vivo precisa de uma chave real do Google AI Studio. Sigo no modo clássico, ouvindo pelo navegador.';

/** Modelos com bidiGenerateContent que não servem para conversa (só transcrição, tradução, música...). */
const NON_CONVERSATIONAL_LIVE = /transcribe|translate|robotics|lyria|music|tts|embedding|image/i;

const quiet = Boolean(process.env.VITEST);
const log = {
  info(message: string): void {
    if (!quiet) console.info(`[Lärk] Voz ao vivo: ${message}`);
  },
  warn(message: string, error?: unknown): void {
    const detail = error === undefined ? '' : ` — ${error instanceof Error ? error.message : String(error)}`;
    console.warn(`[Lärk] Voz ao vivo: ${message}${detail}`);
  },
};

// ─── Autenticação e origem ───────────────────────────────────────────────

export type VoiceAuthChecker = (req: IncomingMessage) => boolean | Promise<boolean>;

let authChecker: VoiceAuthChecker = () => true;

/** Define quem pode abrir o WebSocket de voz (o módulo de autenticação configura; padrão: permitir). */
export function setVoiceAuthChecker(fn: VoiceAuthChecker): void {
  authChecker = typeof fn === 'function' ? fn : () => true;
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|\[?::ffff:127(?:\.\d{1,3}){3}\]?)$/i;
const PRIVATE_HOST =
  /^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|[a-z0-9-]+\.local|[a-z0-9-]+\.ts\.net|\[?f[cd][0-9a-f]{2}:[0-9a-f:]*\]?)$/i;

function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  const colon = value.lastIndexOf(':');
  return colon > 0 && value.indexOf(':') === colon ? value.slice(0, colon) : value;
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOST.test(h) || PRIVATE_HOST.test(h) || h === os.hostname().toLowerCase();
}

function allowedExtraHosts(): string[] {
  return (process.env.LARK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Proteções do navegador que o WebSocket não tem por padrão (não há CORS no upgrade):
 *  - Origin: só a própria página do Lärk, localhost ou a rede local (bloqueia sites quaisquer);
 *  - Host: bloqueia DNS rebinding, a menos que haja senha (o cookie de login protege) ou o host
 *    esteja em LARK_ALLOWED_HOSTS.
 */
export function isAllowedVoiceRequest(req: IncomingMessage): boolean {
  const hostHeader = String(req.headers.host ?? '');
  const hostname = hostnameOf(hostHeader);
  const extra = allowedExtraHosts();
  const hostOk = !hostname || isLocalHostname(hostname) || extra.includes(hostname) || Boolean(config.password);
  if (!hostOk) return false;

  const origin = req.headers.origin;
  if (!origin) return true; // clientes fora do navegador não estão sujeitos a CSRF
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  const originHost = url.host.toLowerCase();
  if (originHost === hostHeader.toLowerCase() || (forwardedHost && originHost === forwardedHost)) return true;
  const originHostname = url.hostname.toLowerCase();
  return isLocalHostname(originHostname) || extra.includes(originHostname);
}

// ─── Instrução de sistema da voz ─────────────────────────────────────────

const LIVE_CHANNEL_NOTES = `# CANAL ATUAL: CONVERSA POR VOZ AO VIVO
Você está falando em tempo real com o usuário, voz a voz. Tudo o que você disser será ouvido, não lido.
- Fale sempre em português do Brasil, com frases naturais e bem ritmadas. Nada de markdown, listas, emojis, códigos ou URLs soletradas.
- Seja breve (em geral de duas a quatro frases), mas sempre deixe uma ideia que faça pensar.
- O usuário pode interromper a qualquer momento: pare, escute e retome o fio sem repetir o que já disse.
- Antes de uma ação demorada ou que precise de aprovação na tela, avise em uma frase curta o que vai fazer.
- Se não entender o áudio, peça com naturalidade para repetir.`;

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function safeSettings(): Settings | null {
  try {
    return getSettings();
  } catch {
    return null;
  }
}

/** Últimas falas da conversa, para a voz continuar de onde o chat (ou a sessão anterior) parou. */
function recentHistoryBlock(conversationId: string, settings: Settings | null): string | null {
  let messages: ChatMessage[];
  try {
    messages = listMessages(conversationId, { limit: RECENT_HISTORY_MESSAGES });
  } catch {
    return null;
  }
  const userLabel = settings?.userName.trim() || 'Usuário';
  const lines = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => `${m.role === 'user' ? userLabel : 'Lärk'}: ${oneLine(m.content, 600)}`);
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > RECENT_HISTORY_CHARS) break;
    kept.unshift(lines[i]);
  }
  if (kept.length === 0) return null;
  return `# CONVERSA RECENTE (continue daqui, sem repetir o que já foi dito)\n${kept.join('\n')}`;
}

/** Persona + contexto (memórias, compromissos, lembretes) + direção de voz + histórico recente. */
export async function buildVoiceInstruction(conversationId: string): Promise<string> {
  const settings = safeSettings();
  const blocks: string[] = [];
  try {
    blocks.push(await buildSystemInstruction({ conversationId, mode: 'voice' }));
  } catch (error) {
    log.warn('contexto completo indisponível; usando a instrução básica', error);
    blocks.push(
      'Você é o Lärk, assistente pessoal do usuário no estilo J.A.R.V.I.S.: assistente, professor e amigo. ' +
        'Fala como um palestrante mestre da oratória e da persuasão, e tudo o que diz carrega uma reflexão.',
    );
  }
  if (settings) {
    try {
      const direction = VOICE_DIRECTION(settings).trim();
      if (direction) blocks.push(`# DIREÇÃO DE VOZ (como dizer — nunca leia isto em voz alta)\n${direction}`);
    } catch (error) {
      log.warn('direção de voz indisponível', error);
    }
  }
  blocks.push(LIVE_CHANNEL_NOTES);
  const recent = recentHistoryBlock(conversationId, settings);
  if (recent) blocks.push(recent);
  return blocks.join('\n\n');
}

// ─── Erros de conexão com o Gemini Live ──────────────────────────────────

/** Erro de abertura/queda do Live com `status` HTTP equivalente (entendido por classifyGeminiError). */
export class LiveConnectionError extends Error {
  readonly status?: number;
  readonly closeCode?: number;
  constructor(message: string, status?: number, closeCode?: number) {
    super(message);
    this.name = 'LiveConnectionError';
    if (status !== undefined) this.status = status;
    if (closeCode !== undefined) this.closeCode = closeCode;
  }
}

/** Traduz o fechamento do WebSocket do Gemini (código + motivo) num erro classificável. */
export function liveCloseError(code: number, reason: string, socketError?: string | null): LiveConnectionError {
  const text = (reason || socketError || '').trim();
  const unexpected = text.match(/Unexpected server response: (\d{3})/i);
  let status: number | undefined;
  if (unexpected) status = Number(unexpected[1]);
  else if (/quota|exceeded|RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(text)) status = 429;
  else if (/api[_ ]?key|unauthenticated|permission|denied|forbidden/i.test(text)) status = 403;
  else if (/not found|is not supported for|not supported by|unsupported model|does not exist/i.test(text)) status = 404;
  else if (code === 1007 || /INVALID_ARGUMENT|invalid argument|unknown name|cannot find field|invalid value/i.test(text)) status = 400;
  else if (code === 1011 || code === 1013 || /unavailable|overloaded|internal error|deadline/i.test(text)) status = 503;
  const message = text ? `Gemini Live: ${text}` : `A conexão com o Gemini Live foi encerrada (código ${code}).`;
  return new LiveConnectionError(message, status, code);
}

function isConversationalLiveModel(model: string): boolean {
  return Boolean(model) && !NON_CONVERSATIONAL_LIVE.test(model);
}

function parseDurationMs(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Texto acumulado de transcrição como exibido ao cliente (sempre cresce como prefixo). */
function displayTranscript(raw: string): string {
  return raw.replace(/\s+/g, ' ').trimStart();
}

function cleanTranscript(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

// ─── Modo demonstração ───────────────────────────────────────────────────

const MOCK_REFLECTIONS = [
  'Toda grande conversa começa com uma pergunta bem feita, e a sua já está no ar.',
  'A voz é a ponte mais curta entre duas mentes; falta só eu ligar a minha de verdade.',
  'Quem fala com clareza pensa com clareza. Configure a chave do Google AI Studio e eu respondo à altura.',
  'Silêncio também é resposta, mas eu prefiro as que mudam alguma coisa. Com a chave do Gemini, mudamos.',
];

export function buildMockVoiceReply(text: string): string {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  const excerpt = oneLine(text, 120);
  return `Modo demonstração: ouvi você dizer “${excerpt}”. ${MOCK_REFLECTIONS[hash % MOCK_REFLECTIONS.length]}`;
}

// ─── Conexão de voz ──────────────────────────────────────────────────────

interface TurnState {
  /** Transcrição bruta da fala do usuário (pedaços concatenados). */
  userText: string;
  /** Texto digitado enviado pela conexão de voz ({type:'text'}). */
  typedText: string;
  /** Transcrição bruta da fala do Lärk. */
  assistantText: string;
  /** Texto (não-pensamento) das partes do modelo, usado se não houver transcrição de saída. */
  modelText: string;
  toolCalls: Map<string, ToolCallInfo>;
  responding: boolean;
  interrupted: boolean;
  userFinalSent: boolean;
}

const newTurn = (): TurnState => ({
  userText: '',
  typedText: '',
  assistantText: '',
  modelText: '',
  toolCalls: new Map(),
  responding: false,
  interrupted: false,
  userFinalSent: false,
});

interface GeminiLink {
  id: number;
  model: string;
  session: Session | null;
  alive: boolean;
  /** Abandonado por nós: eventos dele são ignorados. */
  discarded: boolean;
  lastSocketError: string | null;
}

interface PendingOp {
  kind: 'text' | 'tool';
  run: (session: Session) => void;
}

type ConfigVariant = 'full' | 'minimal';

class VoiceConnection {
  onDispose: (() => void) | null = null;

  private readonly ws: WebSocket;
  private readonly lifetime = new AbortController();
  private readonly pingTimer: NodeJS.Timeout;
  private closed = false;
  private heartbeatOk = true;

  private conversationId: string | null = null;
  private voice = DEFAULT_VOICE;
  private mock = false;
  private starting = false;
  private ready = false;
  private systemInstruction = '';
  private configVariant: ConfigVariant = 'full';

  private link: GeminiLink | null = null;
  private linkSeq = 0;
  private resumeHandle: string | null = null;
  private reconnecting = false;
  private reconnects = 0;
  private goAwayPending = false;
  private goAwayTimer: NodeJS.Timeout | null = null;

  private pendingOps: PendingOp[] = [];
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private pendingTexts: string[] = [];

  private turn: TurnState = newTurn();
  /** Turno interrompido (ou superado por texto digitado) que ainda aguarda o turnComplete do Gemini. */
  private finishing: TurnState | null = null;
  private readonly toolAborts = new Map<string, AbortController>();
  private readonly cancelledCalls = new Set<string>();
  private runningTools = 0;

  private mockAudioWarned = false;
  private mockQueue: Promise<void> = Promise.resolve();
  private droppedAudioWarned = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: RawData, isBinary: boolean) => this.onClientMessage(data, isBinary));
    ws.on('close', () => this.dispose());
    ws.on('error', (error: Error) => {
      log.warn('erro no canal com o navegador', error);
      this.dispose();
    });
    ws.on('pong', () => {
      this.heartbeatOk = true;
    });
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  /** Encerra por iniciativa do servidor (ex.: desligamento), avisando o cliente. */
  terminate(reason: string): void {
    if (this.closed) return;
    this.send({ type: 'closed', reason });
    this.dispose(1001, 'server_shutdown');
  }

  // ── Cliente → servidor ────────────────────────────────────────────────

  private onClientMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    const buf = toBuffer(data);
    if (isBinary) {
      this.onClientAudio(buf);
      return;
    }
    if (buf.length > MAX_JSON_CHARS) return;
    let msg: unknown;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case 'start':
        void this.start(typeof m.conversationId === 'string' && m.conversationId ? m.conversationId : null);
        break;
      case 'text':
        if (typeof m.text === 'string') this.onClientText(m.text);
        break;
      case 'audio_end':
        this.onAudioEnd();
        break;
      case 'stop':
        this.dispose(1000, 'client_stop');
        break;
      default:
        break;
    }
  }

  private async start(requested: string | null): Promise<void> {
    if (this.closed || this.starting) return;
    if (this.ready) {
      if (!requested || requested === this.conversationId) {
        this.sendReady(this.mock ? 'mock' : (this.link?.model ?? 'mock'));
        return;
      }
      // Uma sessão por conexão: trocar de conversa encerra a sessão atual antes de abrir outra.
      this.resetSession();
    }
    this.starting = true;
    try {
      const conversation = (requested ? getConversation(requested) : null) ?? getOrCreateActiveConversation();
      this.conversationId = conversation.id;
      const settings = safeSettings();
      this.voice = resolveVoiceName(settings?.voiceName);

      if (config.mock) {
        this.mock = true;
        this.ready = true;
        this.sendReady('mock');
        log.info('sessão de demonstração iniciada (sem áudio do Gemini)');
        this.flushPendingTexts();
        return;
      }
      if (!getClient()) {
        this.fail('no_api_key', NO_KEY_MESSAGE);
        return;
      }

      this.systemInstruction = await buildVoiceInstruction(conversation.id);
      if (this.closed) return;
      const link = await this.connectBest();
      if (this.closed) {
        this.discardLink(link);
        return;
      }
      this.link = link;
      this.ready = true;
      this.sendReady(link.model);
      log.info(`sessão iniciada (${link.model}, voz ${this.voice})`);
      this.flushPending();
      this.flushPendingTexts();
    } catch (error) {
      if (this.closed) return;
      log.warn('não consegui abrir a sessão ao vivo', error);
      const { code, message } = classifyGeminiError(error);
      this.fail(code, message);
    } finally {
      this.starting = false;
    }
  }

  private onClientText(raw: string): void {
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
    if (!text) return;
    if (!this.ready) {
      if (this.pendingTexts.length < MAX_PENDING_TEXTS) this.pendingTexts.push(text);
      return;
    }
    if (this.mock) {
      this.mockQueue = this.mockQueue.then(() => this.mockReply(text)).catch((error: unknown) => log.warn('falha na resposta simulada', error));
      return;
    }
    // Texto novo enquanto o Lärk responde: a resposta atual pertence ao turno anterior.
    if (this.turn.responding) this.splitTurn();
    this.turn.typedText = this.turn.typedText ? `${this.turn.typedText}\n${text}` : text;
    this.turn.userFinalSent = true;
    this.toGemini({ kind: 'text', run: (s) => s.sendRealtimeInput({ text }) });
  }

  private onClientAudio(buf: Buffer): void {
    if (this.mock) {
      if (!this.mockAudioWarned) {
        this.mockAudioWarned = true;
        this.send({ type: 'error', code: 'provider', message: MOCK_AUDIO_MESSAGE });
      }
      return;
    }
    if ((!this.ready && !this.starting) || buf.length < 2 || buf.length > MAX_AUDIO_FRAME_BYTES) return;
    const pcm = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
    const session = this.liveSession();
    if (session) {
      try {
        session.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: INPUT_MIME } });
        return;
      } catch (error) {
        log.warn('falha ao enviar áudio ao Gemini', error);
      }
    }
    this.bufferAudio(pcm);
  }

  private onAudioEnd(): void {
    if (this.mock || !this.ready) return;
    const session = this.liveSession();
    if (!session) return; // sem sessão viva não há fluxo a encerrar
    try {
      session.sendRealtimeInput({ audioStreamEnd: true });
    } catch (error) {
      log.warn('falha ao sinalizar fim do áudio', error);
    }
  }

  // ── Servidor → cliente ────────────────────────────────────────────────

  private send(msg: VoiceServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (error) {
      log.warn('falha ao enviar mensagem ao navegador', error);
    }
  }

  private sendAudio(pcm: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      if (!this.droppedAudioWarned) {
        this.droppedAudioWarned = true;
        log.warn('o navegador não está acompanhando o áudio; descartando trechos atrasados');
      }
      return;
    }
    this.ws.send(pcm, { binary: true });
  }

  private sendReady(model: string): void {
    if (!this.conversationId) return;
    this.send({ type: 'ready', conversationId: this.conversationId, model, voice: this.voice });
  }

  private fail(code: NonNullable<Extract<VoiceServerMessage, { type: 'error' }>['code']>, message: string): void {
    this.send({ type: 'error', code, message });
    this.dispose(1000, code);
  }

  // ── Sessão Gemini ─────────────────────────────────────────────────────

  private liveConfig(handle: string | null, variant: ConfigVariant): LiveConnectConfig {
    let declarations: FunctionDeclaration[] = [];
    try {
      declarations = getToolDeclarations('voice');
    } catch (error) {
      log.warn('ferramentas indisponíveis nesta sessão', error);
    }
    const cfg: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      systemInstruction: this.systemInstruction,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (declarations.length > 0) cfg.tools = [{ functionDeclarations: declarations }];
    if (variant === 'full') {
      cfg.sessionResumption = handle ? { handle } : {};
      cfg.contextWindowCompression = { slidingWindow: {} };
      cfg.realtimeInputConfig = {
        automaticActivityDetection: {
          // Espera um pouco mais antes de encerrar a fala: pausas de quem pensa não viram interrupção.
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
          prefixPaddingMs: 120,
          silenceDurationMs: 800,
        },
      };
    }
    return cfg;
  }

  /** Abre uma sessão Live; rejeita com erro classificável se o setup falhar, fechar ou demorar. */
  private openLink(model: string, cfg: LiveConnectConfig): Promise<GeminiLink> {
    const ai = getClient();
    if (!ai) return Promise.reject(new GeminiError('no_api_key', NO_KEY_MESSAGE));
    const link: GeminiLink = { id: ++this.linkSeq, model, session: null, alive: true, discarded: false, lastSocketError: null };

    return new Promise<GeminiLink>((resolve, reject) => {
      let settled = false;
      const settle = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        link.alive = false;
        link.discarded = true;
        reject(error);
      };
      const timer = setTimeout(
        () => settle(new LiveConnectionError(`O Gemini Live (${model}) não respondeu a tempo.`, 504)),
        CONNECT_TIMEOUT_MS,
      );
      timer.unref?.();

      ai.live
        .connect({
          model,
          config: cfg,
          callbacks: {
            onmessage: (msg) => this.onGeminiMessage(link, msg),
            onerror: (event) => {
              const message = (event as { message?: unknown } | undefined)?.message;
              link.lastSocketError = typeof message === 'string' && message ? message : 'erro de conexão';
            },
            onclose: (event) => {
              const code = typeof event?.code === 'number' ? event.code : 1006;
              const reason = typeof event?.reason === 'string' ? event.reason : '';
              if (!settled) settle(liveCloseError(code, reason, link.lastSocketError));
              else this.onGeminiClose(link, code, reason);
            },
          },
        })
        .then(
          (session) => {
            if (settled) {
              // Chegou tarde (tempo esgotado ou conexão encerrada): descarta.
              try {
                session.close();
              } catch {
                /* já fechada */
              }
              return;
            }
            settled = true;
            clearTimeout(timer);
            link.session = session;
            resolve(link);
          },
          (error: unknown) => settle(error),
        );
    });
  }

  /** Abre a sessão no modelo dado; se a configuração completa for recusada, tenta a mínima. */
  private async openLinkAdaptive(model: string, handle: string | null): Promise<GeminiLink> {
    try {
      const link = await this.openLink(model, this.liveConfig(handle, 'full'));
      this.configVariant = 'full';
      return link;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status !== 400 || this.closed) throw error;
      log.warn(`o modelo ${model} recusou a configuração completa; tentando a mínima`, error);
      const link = await this.openLink(model, this.liveConfig(null, 'minimal'));
      this.configVariant = 'minimal';
      return link;
    }
  }

  /** Melhor modelo Live disponível, trocando de modelo em cota/404/sobrecarga. */
  private async connectBest(): Promise<GeminiLink> {
    let first = '';
    try {
      first = await resolveModel('live');
    } catch {
      // segue com a lista de reserva
    }
    const candidates = [...new Set([first, ...getModelFallbacks('live')])].filter(isConversationalLiveModel).slice(0, MAX_MODEL_ATTEMPTS);
    if (candidates.length === 0) {
      throw new GeminiError('provider', 'Nenhum modelo de voz ao vivo do Gemini está disponível para a sua chave.');
    }
    let lastError: unknown = null;
    for (const model of candidates) {
      if (this.closed) break;
      try {
        return await this.openLinkAdaptive(model, null);
      } catch (error) {
        lastError = error;
        if (!isRetryableModelError(error)) throw error;
        reportModelFailure(model, error);
        log.warn(`modelo ${model} indisponível agora; tentando o próximo`, error);
      }
    }
    throw lastError ?? new GeminiError('provider', 'Não consegui abrir a sessão de voz ao vivo.');
  }

  private liveSession(): Session | null {
    const link = this.link;
    if (!this.ready || this.reconnecting || !link?.alive || !link.session) return null;
    return link.session;
  }

  /** Envia agora ou guarda para depois da reconexão. */
  private toGemini(op: PendingOp): void {
    const session = this.liveSession();
    if (session) {
      try {
        op.run(session);
        return;
      } catch (error) {
        log.warn('falha ao enviar ao Gemini; guardando para a reconexão', error);
      }
    }
    if (this.pendingOps.length < MAX_PENDING_OPS) this.pendingOps.push(op);
  }

  private bufferAudio(pcm: Buffer): void {
    this.pendingAudio.push(Buffer.from(pcm));
    this.pendingAudioBytes += pcm.length;
    while (this.pendingAudioBytes > MAX_PENDING_AUDIO_BYTES && this.pendingAudio.length > 0) {
      this.pendingAudioBytes -= this.pendingAudio.shift()!.length;
    }
  }

  private flushPending(): void {
    const session = this.liveSession();
    if (!session) return;
    const ops = this.pendingOps.splice(0);
    for (const op of ops) {
      try {
        op.run(session);
      } catch (error) {
        log.warn('falha ao reenviar ao Gemini', error);
      }
    }
    const audio = this.pendingAudio.splice(0);
    this.pendingAudioBytes = 0;
    for (const pcm of audio) {
      try {
        session.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: INPUT_MIME } });
      } catch {
        break;
      }
    }
  }

  private flushPendingTexts(): void {
    const texts = this.pendingTexts.splice(0);
    for (const text of texts) this.onClientText(text);
  }

  private discardLink(link: GeminiLink): void {
    link.discarded = true;
    link.alive = false;
    try {
      link.session?.close();
    } catch {
      /* já fechada */
    }
  }

  private resetSession(): void {
    if (this.link) this.discardLink(this.link);
    this.link = null;
    this.ready = false;
    this.mock = false;
    this.resumeHandle = null;
    this.goAwayPending = false;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    for (const controller of this.toolAborts.values()) controller.abort(new Error('Sessão de voz reiniciada.'));
    this.pendingOps = [];
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.turn = newTurn();
    this.finishing = null;
  }

  // ── Mensagens do Gemini ───────────────────────────────────────────────

  private onGeminiMessage(link: GeminiLink, msg: LiveServerMessage): void {
    if (link.discarded || this.closed) return;
    const update = msg.sessionResumptionUpdate;
    if (update?.newHandle && update.resumable !== false) this.resumeHandle = update.newHandle;
    if (msg.goAway) this.onGoAway(link, msg.goAway.timeLeft);
    if (msg.serverContent) this.onServerContent(msg.serverContent);
    if (msg.toolCall?.functionCalls?.length) void this.onToolCall(msg.toolCall.functionCalls);
    if (msg.toolCallCancellation?.ids?.length) this.onToolCancel(msg.toolCallCancellation.ids);
  }

  /** Turno que recebe a resposta do modelo agora (o interrompido, se ainda não concluiu). */
  private responseTurn(): TurnState {
    return this.finishing ?? this.turn;
  }

  private markResponding(turn: TurnState): void {
    if (turn.responding) return;
    turn.responding = true;
    if (!turn.userFinalSent) {
      turn.userFinalSent = true;
      const text = displayTranscript(turn.userText);
      if (text) this.send({ type: 'user_transcript', text, final: true });
    }
  }

  private onServerContent(content: LiveServerContent): void {
    const input = content.inputTranscription;
    if (input?.text) {
      const turn = this.turn;
      turn.userText += input.text;
      const final = Boolean(input.finished);
      if (final) turn.userFinalSent = true;
      const text = displayTranscript(turn.userText);
      if (text) this.send({ type: 'user_transcript', text, final });
    }

    const parts = content.modelTurn?.parts;
    if (parts?.length) {
      const turn = this.responseTurn();
      for (const part of parts) {
        const inline = part.inlineData;
        if (inline?.data && (!inline.mimeType || inline.mimeType.startsWith('audio/'))) {
          this.markResponding(turn);
          this.sendAudio(Buffer.from(inline.data, 'base64'));
        } else if (part.text && !part.thought) {
          this.markResponding(turn);
          turn.modelText += part.text;
          if (!turn.assistantText) {
            const text = displayTranscript(turn.modelText);
            if (text) this.send({ type: 'assistant_transcript', text, final: false });
          }
        }
      }
    }

    const output = content.outputTranscription;
    if (output?.text) {
      const turn = this.responseTurn();
      this.markResponding(turn);
      turn.assistantText += output.text;
      const text = displayTranscript(turn.assistantText);
      if (text) this.send({ type: 'assistant_transcript', text, final: false });
    }

    if (content.interrupted) this.onInterrupted();
    if (content.turnComplete) this.onTurnComplete();
  }

  /** O turno atual vira "finishing" (aguarda o turnComplete) e um turno novo começa. */
  private splitTurn(): void {
    if (this.finishing) this.persistTurn(this.finishing);
    this.finishing = this.turn;
    this.turn = newTurn();
  }

  private onInterrupted(): void {
    this.send({ type: 'interrupted' });
    if (this.finishing) {
      this.finishing.interrupted = true;
    } else if (this.turn.responding) {
      this.turn.interrupted = true;
      this.splitTurn();
    }
  }

  private onTurnComplete(): void {
    const done = this.finishing ?? this.turn;
    if (this.finishing) this.finishing = null;
    else this.turn = newTurn();
    this.persistTurn(done);
    if (this.goAwayPending && this.isIdle()) void this.resume('goaway');
  }

  private isIdle(): boolean {
    return !this.finishing && !this.turn.responding && this.runningTools === 0 && !this.turn.userText.trim() && !this.turn.typedText;
  }

  private ensureConversation(): string {
    if (this.conversationId && getConversation(this.conversationId)) return this.conversationId;
    // A conversa foi apagada durante a sessão: continua na conversa ativa (ou numa nova).
    this.conversationId = getOrCreateActiveConversation().id;
    return this.conversationId;
  }

  /** Salva o turno (usuário + Lärk), avisa o cliente e agenda o pós-turno. */
  private persistTurn(turn: TurnState, notifyClient = true): void {
    const userText = cleanTranscript(turn.typedText) || cleanTranscript(turn.userText);
    let assistantText = cleanTranscript(turn.assistantText) || cleanTranscript(turn.modelText);
    if (assistantText && turn.interrupted && !/[.!?…]$/.test(assistantText)) assistantText += '…';
    const toolCalls = [...turn.toolCalls.values()];

    if (notifyClient) {
      if (userText && !turn.userFinalSent) this.send({ type: 'user_transcript', text: userText, final: true });
      if (assistantText) this.send({ type: 'assistant_transcript', text: assistantText, final: true });
    }

    let userMessage: ChatMessage | null = null;
    let assistantMessage: ChatMessage | null = null;
    let conversationId: string | null = null;
    if (userText || assistantText || toolCalls.length > 0) {
      try {
        conversationId = this.ensureConversation();
        if (userText) userMessage = addMessage({ conversationId, role: 'user', content: userText, kind: 'voice' });
        if (assistantText || toolCalls.length > 0) {
          assistantMessage = addMessage({
            conversationId,
            role: 'assistant',
            content: assistantText,
            kind: 'voice',
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          });
        }
      } catch (error) {
        log.warn('não consegui salvar o turno de voz', error);
      }
    }
    if (notifyClient) this.send({ type: 'turn_complete', userMessage, assistantMessage });
    if (conversationId && (userMessage || assistantMessage)) {
      try {
        schedulePostTurn(conversationId);
      } catch (error) {
        log.warn('pós-turno indisponível', error);
      }
    }
  }

  // ── Ferramentas ───────────────────────────────────────────────────────

  private async onToolCall(calls: FunctionCall[]): Promise<void> {
    const turn = this.responseTurn();
    this.markResponding(turn);
    this.runningTools++;
    try {
      const responses = await Promise.all(calls.map((fc) => this.runOneTool(fc, turn)));
      const valid = responses.filter((r): r is FunctionResponse => r !== null);
      if (valid.length > 0 && !this.closed) {
        this.toGemini({ kind: 'tool', run: (s) => s.sendToolResponse({ functionResponses: valid }) });
      }
    } finally {
      this.runningTools--;
      if (this.goAwayPending && this.isIdle()) void this.resume('goaway');
    }
  }

  private async runOneTool(fc: FunctionCall, turn: TurnState): Promise<FunctionResponse | null> {
    const name = fc.name ?? '';
    const callId = fc.id || newId();
    const controller = new AbortController();
    this.toolAborts.set(callId, controller);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    try {
      const { call, result } = await runTool(
        name,
        fc.args ?? {},
        {
          conversationId: this.conversationId ?? this.ensureConversation(),
          mode: 'voice',
          emit: (update) => {
            turn.toolCalls.set(update.id, update);
            this.send({ type: 'tool', call: update });
          },
          signal,
        },
        callId,
      );
      turn.toolCalls.set(call.id, call);
      if (controller.signal.aborted || this.cancelledCalls.has(callId) || this.closed) return null;

      const output: Record<string, unknown> = { ...result.output };
      // Imagens (ex.: captura de tela) seguem como quadro de vídeo para o modelo enxergar.
      const images = (result.inlineData ?? []).filter((d) => /^image\/(?:jpeg|png|webp)$/i.test(d.mimeType));
      if (images.length > 0) {
        for (const image of images) {
          this.toGemini({ kind: 'tool', run: (s) => s.sendRealtimeInput({ video: { data: image.data, mimeType: image.mimeType } }) });
        }
        output.image_note = 'A imagem resultante foi enviada a você como quadro de vídeo; descreva-a com base no que você vê.';
      }
      return { id: fc.id, name, response: output };
    } catch (error) {
      // runTool não deveria lançar; se lançar, o modelo recebe o erro e explica ao usuário.
      log.warn(`falha inesperada na ferramenta ${name}`, error);
      return { id: fc.id, name, response: { error: error instanceof Error ? error.message : String(error) } };
    } finally {
      this.toolAborts.delete(callId);
      this.cancelledCalls.delete(callId);
    }
  }

  private onToolCancel(ids: string[]): void {
    for (const id of ids) {
      this.cancelledCalls.add(id);
      this.toolAborts.get(id)?.abort(new Error('O Gemini cancelou esta ação.'));
    }
  }

  // ── Reconexão (goAway, quedas) ────────────────────────────────────────

  private onGoAway(link: GeminiLink, timeLeft: string | undefined): void {
    if (link !== this.link || this.goAwayPending || this.reconnecting) return;
    this.goAwayPending = true;
    const ms = parseDurationMs(timeLeft) ?? 10_000;
    log.info(`o Gemini pediu para renovar a sessão (restam ${Math.round(ms / 1000)} s)`);
    if (this.isIdle()) {
      void this.resume('goaway');
      return;
    }
    // Espera o turno atual acabar, mas não passa do prazo.
    this.goAwayTimer = setTimeout(() => void this.resume('goaway'), Math.max(0, ms - 1_500));
    this.goAwayTimer.unref?.();
  }

  private onGeminiClose(link: GeminiLink, code: number, reason: string): void {
    link.alive = false;
    if (link.discarded || this.closed || link !== this.link || this.reconnecting) return;
    const error = liveCloseError(code, reason, link.lastSocketError);
    const { code: errorCode, message } = classifyGeminiError(error);
    if (errorCode === 'no_api_key') {
      this.fail(errorCode, message);
      return;
    }
    if (errorCode === 'quota') {
      // Cota do modelo atual estourou: retoma do zero em outro modelo.
      reportModelFailure(link.model, error);
      this.resumeHandle = null;
    }
    // A resposta em andamento se perdeu com a conexão: registra o que já foi dito.
    if (this.finishing) {
      this.finishing.interrupted = true;
      this.persistTurn(this.finishing);
      this.finishing = null;
    }
    if (this.turn.responding) {
      this.turn.interrupted = true;
      this.persistTurn(this.turn);
    }
    this.turn = newTurn();
    log.info(`conexão com o Gemini encerrada (${code}${reason ? `: ${reason}` : ''}); retomando`);
    void this.resume('closed');
  }

  private async resume(reason: 'goaway' | 'closed'): Promise<void> {
    if (this.closed || this.reconnecting || this.mock || !this.ready) return;
    this.reconnecting = true;
    this.goAwayPending = false;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    const old = this.link;
    let lastError: unknown = null;
    try {
      for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS; attempt++) {
        if (this.closed) return;
        if (++this.reconnects > MAX_RECONNECTS_PER_CONNECTION) break;
        const handle = old ? this.resumeHandle : null;
        try {
          let link: GeminiLink;
          if (handle && old) {
            link = await this.openLink(old.model, this.liveConfig(handle, this.configVariant));
          } else {
            // Sem handle o Gemini perde o contexto: reconstrói a instrução com o histórico salvo.
            if (this.conversationId) this.systemInstruction = await buildVoiceInstruction(this.ensureConversation());
            this.pendingOps = this.pendingOps.filter((op) => op.kind !== 'tool');
            link = await this.connectBest();
          }
          if (this.closed) {
            this.discardLink(link);
            return;
          }
          this.link = link;
          if (old && old !== link) this.discardLink(old);
          this.reconnecting = false;
          log.info(`sessão renovada (${reason === 'goaway' ? 'pedido do Gemini' : 'queda'}, ${link.model}${handle ? ', contexto preservado' : ''})`);
          this.flushPending();
          return;
        } catch (error) {
          lastError = error;
          if (handle) this.resumeHandle = null; // handle expirado ou recusado: próxima tentativa começa do zero
          if (classifyGeminiError(error).code === 'no_api_key') break;
          await delay(RESUME_BACKOFF_MS * (attempt + 1));
        }
      }
      if (this.closed) return;
      log.warn('não consegui retomar a sessão ao vivo', lastError ?? undefined);
      const { code, message } = classifyGeminiError(
        lastError ?? new GeminiError('provider', 'A sessão de voz ao vivo caiu e não consegui retomá-la.'),
      );
      this.fail(code, message);
    } finally {
      this.reconnecting = false;
    }
  }

  // ── Modo demonstração ─────────────────────────────────────────────────

  private async mockReply(text: string): Promise<void> {
    if (this.closed) return;
    const turn = newTurn();
    turn.typedText = text;
    turn.userFinalSent = true;
    this.send({ type: 'user_transcript', text, final: true });
    const reply = buildMockVoiceReply(text);
    const words = reply.split(' ');
    const step = Math.ceil(words.length / 3);
    for (let i = step; i < words.length + step; i += step) {
      await delay(quiet ? 0 : 140);
      if (this.closed) return;
      turn.responding = true;
      turn.assistantText = words.slice(0, Math.min(i, words.length)).join(' ');
      this.send({ type: 'assistant_transcript', text: turn.assistantText, final: false });
    }
    turn.assistantText = reply;
    this.persistTurn(turn);
  }

  // ── Ciclo de vida ─────────────────────────────────────────────────────

  private heartbeat(): void {
    if (this.closed) return;
    if (!this.heartbeatOk) {
      log.info('o navegador parou de responder; encerrando a sessão');
      this.ws.terminate();
      this.dispose();
      return;
    }
    this.heartbeatOk = false;
    try {
      this.ws.ping();
    } catch {
      this.dispose();
    }
  }

  /** Fecha tudo: sessão do Gemini, ferramentas em andamento, timers e o WebSocket. */
  private dispose(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    this.lifetime.abort(new Error('A conversa por voz foi encerrada.'));
    for (const controller of this.toolAborts.values()) controller.abort(new Error('A conversa por voz foi encerrada.'));

    // Guarda o que já foi dito num turno que não chegou a concluir (memória nunca se perde).
    if (!this.mock) {
      for (const turn of [this.finishing, this.turn]) {
        if (turn && (turn.responding || turn.toolCalls.size > 0)) {
          turn.interrupted = true;
          this.persistTurn(turn, false);
        }
      }
    }
    this.finishing = null;
    this.turn = newTurn();

    if (this.link) {
      this.discardLink(this.link);
      log.info('sessão encerrada');
    }
    this.link = null;
    this.ready = false;
    this.pendingOps = [];
    this.pendingAudio = [];
    this.pendingTexts = [];
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(code, reason.slice(0, 100));
      }
    } catch {
      this.ws.terminate();
    }
    const onDispose = this.onDispose;
    this.onDispose = null;
    onDispose?.();
  }
}

// ─── Servidor WebSocket ──────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
const attachedServers = new WeakSet<Server>();
const connections = new Set<VoiceConnection>();

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function acceptUpgrade(server: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  socket.on('error', () => socket.destroy());
  if (!isAllowedVoiceRequest(req)) {
    log.warn(`conexão recusada de origem não permitida (${String(req.headers.origin ?? 'sem origem')})`);
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }
  let allowed = false;
  try {
    allowed = await authChecker(req);
  } catch (error) {
    log.warn('falha ao verificar a autenticação', error);
  }
  if (!allowed) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  if (connections.size >= MAX_CONNECTIONS) {
    rejectUpgrade(socket, 503, 'Service Unavailable');
    return;
  }
  if (socket.destroyed) return;
  server.handleUpgrade(req, socket, head, (ws) => {
    const connection = new VoiceConnection(ws);
    connections.add(connection);
    connection.onDispose = () => connections.delete(connection);
  });
}

/** Anexa o WebSocket da voz (/api/voice) ao servidor HTTP. Idempotente por servidor. */
export function attachVoiceServer(server: Server): void {
  if (attachedServers.has(server)) return;
  attachedServers.add(server);
  wss ??= new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  const wsServer = wss;
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (requestPath(req) !== VOICE_PATH) {
      // Outro manipulador de upgrade pode cuidar disso; sem nenhum, recusa para não deixar o socket pendurado.
      if (server.listenerCount('upgrade') <= 1) rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    void acceptUpgrade(wsServer, req, socket, head).catch((error: unknown) => {
      log.warn('falha ao aceitar a conexão de voz', error);
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });
  });
  server.once('close', () => shutdownVoiceServer());
}

/** Encerra todas as conversas de voz abertas (desligamento do servidor). */
export function shutdownVoiceServer(reason = 'O servidor do Lärk foi encerrado.'): void {
  for (const connection of [...connections]) connection.terminate(reason);
  connections.clear();
}

/** Quantas conversas de voz estão abertas agora (diagnóstico). */
export function activeVoiceSessions(): number {
  return connections.size;
}
