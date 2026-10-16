/**
 * Voz ao vivo da edição web: ponte entre o WebSocket falso de /api/voice e o Gemini Live,
 * aberto DIRETO do navegador com o SDK web '@google/genai' e a chave salva neste aparelho.
 *
 * Fala exatamente o protocolo de shared/types.ts (VoiceClientMessage/VoiceServerMessage):
 *  - binário cliente → Live: PCM16 mono 16 kHz do microfone (sendRealtimeInput audio);
 *  - binário Live → cliente: PCM16 mono 24 kHz da voz do Lärk;
 *  - JSON: ready, transcrições, ferramentas, interrupção, fim de turno, erros e encerramento.
 * Cada turno concluído vira mensagens salvas (kind 'voice') no armazenamento local.
 * O SDK é carregado sob demanda (import dinâmico) para não pesar na abertura da página.
 */
import type {
  FunctionCall,
  FunctionResponse,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerMessage,
  Session,
} from '@google/genai';
import type { ChatMessage, Settings, ToolCallInfo, VoiceServerMessage } from '@shared/types';
import { addMessage, getApiKey, getConversation, getOrCreateActiveConversation, getSettings, listMessages, updateMessage } from './db';
import { isGeminiUnreachable } from './gemini';
import { buildContext, buildPersona } from './persona';
import { LOCAL_TOOLS, runTool } from './tools';
import { truncate } from './util';

// ─── Parâmetros ──────────────────────────────────────────────────────────

/** Ordem de preferência dos modelos Live (com reserva se a conexão falhar). */
export const LIVE_MODELS = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-latest'];
const DEFAULT_VOICE = 'Charon';
const INPUT_MIME = 'audio/pcm;rate=16000';
/** O cliente desiste em 10 s: cada tentativa tem bem menos que isso. */
const CONNECT_TIMEOUT_MS = 6_000;
const TOTAL_CONNECT_BUDGET_MS = 9_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_AUDIO_FRAME_BYTES = 256 * 1024;
const RECENT_HISTORY_MESSAGES = 14;
const RECENT_HISTORY_CHARS = 6_000;
/** Modelos com bidiGenerateContent que não servem para conversa. */
const NON_CONVERSATIONAL_LIVE = /transcribe|translate|robotics|lyria|music|tts|embedding|image/i;

export const PAGES_URL = 'https://lucasbronstrup.github.io/l-rk/';

const NO_KEY_MESSAGE =
  'A voz ao vivo precisa da sua chave gratuita do Google AI Studio. Cole-a em Configurações → Inteligência e abra o modo de voz de novo.';
const CLAUDE_BLOCKED_MESSAGE =
  `Dentro do claude.ai o navegador bloqueia a conexão com o Google, então a voz ao vivo do Gemini não abre aqui. Para conversar por voz ao vivo, abra o Lärk em ${PAGES_URL} e cole sua chave em Configurações → Inteligência.`;
const UNREACHABLE_MESSAGE =
  'Não consegui abrir a conexão com os servidores do Google a partir desta página (rede, extensão ou bloqueador). Confira a internet e desative bloqueadores para este site.';
const KEY_REJECTED_MESSAGE =
  'O Google recusou a chave salva (inválida, revogada ou sem permissão para a voz ao vivo). Cole uma chave nova do Google AI Studio em Configurações → Inteligência.';
const QUOTA_MESSAGE = 'A cota gratuita da voz ao vivo do Gemini se esgotou por agora. Ela se renova sozinha; enquanto isso, sigo no modo clássico.';

/** A página está dentro do claude.ai (Artifact): lá o domínio do Google é bloqueado. */
export function isInsideClaudeAi(): boolean {
  try {
    const host = window.location.hostname;
    if (/(^|\.)claude\.ai$|claudeusercontent\.com$|claude\.site$/i.test(host)) return true;
  } catch {
    /* sem location */
  }
  const runtime = (window as unknown as { claude?: { use?: unknown } }).claude;
  return Boolean(runtime && typeof runtime.use === 'function');
}

// ─── Base64 / binário ────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ─── Instrução de sistema da voz ─────────────────────────────────────────

const VOICE_CHANNEL_NOTES = `# CANAL ATUAL: CONVERSA POR VOZ AO VIVO (prevalece sobre as regras de formato acima)
Você está falando em tempo real com o usuário, voz a voz. Tudo o que você disser será OUVIDO, não lido.
- Fale em português do Brasil, com frases feitas para serem faladas. Nada de markdown, listas, títulos, emojis, códigos ou URLs.
- Oratória: abra com um gancho, use pausas de efeito (frases curtas, ponto final), varie o ritmo e feche com uma ideia que fica.
- Toda resposta carrega uma reflexão, integrada com naturalidade — nunca anunciada como "reflexão".
- Seja breve: em geral de duas a quatro frases. Respostas simples merecem respostas curtas.
- Tom do alter ego: calmo por dentro, firme por fora, voz do peito, humor seco. Use o bordão "Bora?" com naturalidade, não em toda fala.
- O usuário pode interromper a qualquer momento: pare, escute e retome o fio sem repetir o que já disse.
- Se não entender o áudio, peça com naturalidade para repetir.`;

function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' '), max);
}

function recentHistoryBlock(conversationId: string, settings: Settings): string | null {
  let messages: ChatMessage[];
  try {
    messages = listMessages(conversationId, { limit: RECENT_HISTORY_MESSAGES });
  } catch {
    return null;
  }
  const userLabel = settings.userName.trim() || 'Usuário';
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
  return kept.length ? `# CONVERSA RECENTE (continue daqui, sem repetir o que já foi dito)\n${kept.join('\n')}` : null;
}

/** Persona do Lärk + contexto (data/hora, memórias, promessas, lembretes) + regras da voz + histórico. */
export function buildVoiceInstruction(settings: Settings, conversationId: string): string {
  const blocks = [buildPersona(settings), buildContext(settings, { conversationId }), VOICE_CHANNEL_NOTES];
  const style = settings.voiceStyle.trim();
  if (style) blocks.push(`# DIREÇÃO DE VOZ (como dizer — nunca leia isto em voz alta)\n${oneLine(style, 300)}`);
  const recent = recentHistoryBlock(conversationId, settings);
  if (recent) blocks.push(recent);
  return blocks.join('\n\n');
}

// ─── Erros ───────────────────────────────────────────────────────────────

type ErrorCode = NonNullable<Extract<VoiceServerMessage, { type: 'error' }>['code']>;

/** Falha ao abrir/perder a sessão Live, com um "status" HTTP equivalente para decidir a reserva. */
class LiveError extends Error {
  readonly status: number;
  readonly opened: boolean;
  constructor(message: string, status: number, opened = true) {
    super(message);
    this.name = 'LiveError';
    this.status = status;
    this.opened = opened;
  }
}

function statusFromClose(code: number, reason: string): number {
  const text = reason.trim();
  if (/quota|exceeded|RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(text)) return 429;
  if (/api[_ ]?key|unauthenticated|permission|denied|forbidden/i.test(text)) return 403;
  if (/not found|is not supported for|not supported by|unsupported model|does not exist/i.test(text)) return 404;
  if (code === 1007 || /INVALID_ARGUMENT|invalid argument|unknown name|cannot find field|invalid value/i.test(text)) return 400;
  if (code === 1008) return 403;
  if (code === 1011 || code === 1013 || /unavailable|overloaded|internal error|deadline/i.test(text)) return 503;
  return 0;
}

// ─── Turnos ──────────────────────────────────────────────────────────────

interface TurnState {
  userText: string;
  typedText: string;
  assistantText: string;
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

const display = (raw: string) => raw.replace(/\s+/g, ' ').trimStart();
const clean = (raw: string) => raw.replace(/\s+/g, ' ').trim();

/** Texto para comparar transcrições: sem acentos, pontuação, espaços nem caixa. */
function normSpeech(t: string): string {
  return t
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 400);
}

/** Semelhança 0..1 pela distância de edição. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * A transcrição final `next` é uma versão refinada de `prev` (o Live às vezes reenvia a fala
 * inteira, pontuada, ao concluir) — e não a continuação dela.
 */
function isRewrite(prev: string, next: string): boolean {
  const a = normSpeech(prev);
  const b = normSpeech(next);
  if (a.length < 4 || b.length < a.length * 0.6) return false;
  return similarity(a, b) >= 0.7;
}

// ─── Ponte ───────────────────────────────────────────────────────────────

export interface VoiceSink {
  json(msg: VoiceServerMessage): void;
  audio(pcm: ArrayBuffer): void;
  close(code: number, reason: string): void;
}

type GenaiModule = typeof import('@google/genai');
let genaiPromise: Promise<GenaiModule> | null = null;
function loadGenai(): Promise<GenaiModule> {
  if (!genaiPromise) {
    genaiPromise = import('@google/genai');
    genaiPromise.catch(() => {
      genaiPromise = null;
    });
  }
  return genaiPromise;
}

interface Link {
  model: string;
  session: Session | null;
  alive: boolean;
  discarded: boolean;
}

type Variant = 'full' | 'minimal';

export class LiveVoiceBridge {
  private readonly sink: VoiceSink;
  private closed = false;
  private starting = false;
  private ready = false;
  private conversationId: string | null = null;
  private voice = DEFAULT_VOICE;
  private link: Link | null = null;
  private pendingTexts: string[] = [];
  private turn: TurnState = newTurn();
  private finishing: TurnState | null = null;
  private runningTools = 0;
  private goAwayPending = false;
  /** Última fala do usuário salva (para aplicar um refinamento tardio da transcrição). */
  private lastSaved: { id: string; text: string; at: number } | null = null;

  constructor(sink: VoiceSink) {
    this.sink = sink;
  }

  // ── Cliente → ponte ───────────────────────────────────────────────────

  handleClient(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.closed) return;
    if (typeof data !== 'string') {
      if (data instanceof Blob) {
        void data.arrayBuffer().then((buf) => this.onClientAudio(new Uint8Array(buf)));
      } else if (data instanceof ArrayBuffer) {
        this.onClientAudio(new Uint8Array(data));
      } else {
        this.onClientAudio(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      return;
    }
    if (data.length > 64 * 1024) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
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
        this.withSession((s) => s.sendRealtimeInput({ audioStreamEnd: true }));
        break;
      case 'stop':
        this.shutdown(1000, 'client_stop');
        break;
      default:
        break;
    }
  }

  /** O cliente fechou o WebSocket falso. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.dropLink();
    // Guarda o que já foi dito no turno em andamento (sem duplicar um refinamento da última fala).
    if (this.finishing) this.persistTurn(this.finishing, false);
    const t = this.turn;
    const userOnly = !t.typedText && !t.assistantText && !t.modelText && t.toolCalls.size === 0;
    if (!(userOnly && this.lastSaved && isRewrite(this.lastSaved.text, t.userText))) this.persistTurn(t, false);
    this.finishing = null;
    this.turn = newTurn();
  }

  private async start(requested: string | null): Promise<void> {
    if (this.closed || this.starting) return;
    if (this.ready && this.link) {
      this.sendReady(this.link.model);
      return;
    }
    this.starting = true;
    try {
      if (isInsideClaudeAi()) return this.fail('provider', CLAUDE_BLOCKED_MESSAGE);
      const key = getApiKey();
      if (!key) return this.fail('no_api_key', NO_KEY_MESSAGE);
      if (isGeminiUnreachable()) return this.fail('provider', UNREACHABLE_MESSAGE);

      const conversation = (requested ? getConversation(requested) : null) ?? getOrCreateActiveConversation();
      this.conversationId = conversation.id;
      const settings = getSettings();
      this.voice = settings.voiceName.trim() || DEFAULT_VOICE;
      const instruction = buildVoiceInstruction(settings, conversation.id);

      let genai: GenaiModule;
      try {
        genai = await loadGenai();
      } catch {
        return this.fail('provider', 'Não consegui carregar o módulo de voz ao vivo. Recarregue a página e tente de novo.');
      }
      if (this.closed) return;

      const link = await this.connectBest(genai, key, instruction, settings.models.live);
      if (this.closed) {
        this.discard(link);
        return;
      }
      this.link = link;
      this.ready = true;
      this.sendReady(link.model);
      console.info(`[Lärk web] Voz ao vivo: sessão aberta (${link.model}, voz ${this.voice}).`);
      for (const t of this.pendingTexts.splice(0)) this.onClientText(t);
    } catch (e) {
      if (this.closed) return;
      const { code, message } = this.classify(e);
      console.warn('[Lärk web] Voz ao vivo indisponível:', e instanceof Error ? e.message : e);
      this.fail(code, message);
    } finally {
      this.starting = false;
    }
  }

  private classify(e: unknown): { code: ErrorCode; message: string } {
    if (e instanceof LiveError) {
      if (e.status === 429) return { code: 'quota', message: QUOTA_MESSAGE };
      if (e.status === 401 || e.status === 403) return { code: 'no_api_key', message: KEY_REJECTED_MESSAGE };
      if (!e.opened) return { code: 'provider', message: isInsideClaudeAi() ? CLAUDE_BLOCKED_MESSAGE : UNREACHABLE_MESSAGE };
      if (e.status === 404) {
        return { code: 'provider', message: 'Nenhum modelo de voz ao vivo do Gemini está disponível para a sua chave agora. Sigo no modo clássico.' };
      }
      return { code: 'provider', message: `A voz ao vivo do Gemini não abriu (${truncate(e.message, 140)}). Sigo no modo clássico.` };
    }
    return { code: 'provider', message: 'A voz ao vivo do Gemini não respondeu bem. Sigo no modo clássico, sem perder o fio da conversa.' };
  }

  private onClientText(raw: string): void {
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
    if (!text) return;
    if (!this.ready) {
      if (this.pendingTexts.length < 5) this.pendingTexts.push(text);
      return;
    }
    // Texto novo enquanto o Lärk responde: a resposta atual pertence ao turno anterior.
    if (this.turn.responding) this.splitTurn();
    this.turn.typedText = this.turn.typedText ? `${this.turn.typedText}\n${text}` : text;
    this.turn.userFinalSent = true;
    this.withSession((s) => s.sendRealtimeInput({ text }));
  }

  private onClientAudio(bytes: Uint8Array): void {
    if (!this.ready || bytes.byteLength < 2 || bytes.byteLength > MAX_AUDIO_FRAME_BYTES) return;
    const pcm = bytes.byteLength % 2 === 0 ? bytes : bytes.subarray(0, bytes.byteLength - 1);
    const data = bytesToBase64(pcm);
    this.withSession((s) => s.sendRealtimeInput({ audio: { data, mimeType: INPUT_MIME } }));
  }

  private withSession(fn: (s: Session) => void): void {
    const link = this.link;
    if (!this.ready || !link?.alive || !link.session) return;
    try {
      fn(link.session);
    } catch (e) {
      console.warn('[Lärk web] Voz ao vivo: falha ao enviar ao Gemini —', e instanceof Error ? e.message : e);
    }
  }

  // ── Ponte → cliente ───────────────────────────────────────────────────

  private send(msg: VoiceServerMessage): void {
    if (!this.closed) this.sink.json(msg);
  }

  private sendReady(model: string): void {
    if (!this.conversationId) return;
    this.send({ type: 'ready', conversationId: this.conversationId, model, voice: this.voice });
  }

  private fail(code: ErrorCode, message: string): void {
    this.send({ type: 'error', code, message });
    this.shutdown(1000, code);
  }

  /** Encerra a ponte e o WebSocket falso. */
  private shutdown(code: number, reason: string): void {
    if (this.closed) return;
    this.dispose();
    this.sink.close(code, reason);
  }

  // ── Sessão Gemini ─────────────────────────────────────────────────────

  private liveConfig(genai: GenaiModule, instruction: string, variant: Variant): LiveConnectConfig {
    const cfg: LiveConnectConfig = {
      responseModalities: [genai.Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      systemInstruction: instruction,
      tools: [
        {
          functionDeclarations: LOCAL_TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })),
        },
      ],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (variant === 'full') {
      cfg.contextWindowCompression = { slidingWindow: {} };
      cfg.realtimeInputConfig = {
        automaticActivityDetection: {
          // Pausas de quem pensa não viram fim de fala.
          endOfSpeechSensitivity: genai.EndSensitivity.END_SENSITIVITY_LOW,
          prefixPaddingMs: 120,
          silenceDurationMs: 800,
        },
      };
    }
    return cfg;
  }

  private openLink(genai: GenaiModule, key: string, model: string, cfg: LiveConnectConfig, timeoutMs: number): Promise<Link> {
    const link: Link = { model, session: null, alive: true, discarded: false };
    const ai = new genai.GoogleGenAI({ apiKey: key });
    return new Promise<Link>((resolve, reject) => {
      let settled = false;
      let opened = false;
      let socketError = '';
      const settle = (err: LiveError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        link.alive = false;
        link.discarded = true;
        reject(err);
      };
      const timer = setTimeout(() => settle(new LiveError(`O Gemini Live (${model}) não respondeu a tempo.`, 504, opened)), timeoutMs);
      ai.live
        .connect({
          model,
          config: cfg,
          callbacks: {
            onopen: () => {
              opened = true;
            },
            onmessage: (msg: LiveServerMessage) => this.onGeminiMessage(link, msg),
            onerror: (ev: unknown) => {
              const m = (ev as { message?: unknown } | undefined)?.message;
              socketError = typeof m === 'string' && m ? m : 'erro de conexão';
            },
            onclose: (ev: CloseEvent) => {
              const code = typeof ev?.code === 'number' ? ev.code : 1006;
              const reason = typeof ev?.reason === 'string' ? ev.reason : '';
              if (!settled) {
                const status = statusFromClose(code, reason);
                settle(new LiveError(reason || socketError || `conexão encerrada (código ${code})`, status, opened));
              } else {
                this.onGeminiClose(link, code, reason);
              }
            },
          },
        })
        .then(
          (session) => {
            if (settled) {
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
          (e: unknown) => settle(new LiveError(e instanceof Error ? e.message : String(e), 0, opened)),
        );
    });
  }

  private async connectBest(genai: GenaiModule, key: string, instruction: string, preferred: string): Promise<Link> {
    const pref = preferred.trim().replace(/^models\//, '');
    const candidates = [...new Set([pref, ...LIVE_MODELS])].filter((m) => m && !NON_CONVERSATIONAL_LIVE.test(m));
    const deadline = Date.now() + TOTAL_CONNECT_BUDGET_MS;
    let lastError: unknown = null;
    let sawQuota = false;
    for (const model of candidates) {
      if (this.closed) break;
      const left = deadline - Date.now();
      if (left < 1_000) break;
      for (const variant of ['full', 'minimal'] as const) {
        try {
          return await this.openLink(genai, key, model, this.liveConfig(genai, instruction, variant), Math.min(CONNECT_TIMEOUT_MS, deadline - Date.now()));
        } catch (e) {
          lastError = e;
          if (!(e instanceof LiveError)) throw e;
          // Domínio do Google inalcançável: não adianta trocar de modelo.
          if (!e.opened) throw e;
          if (e.status === 401 || e.status === 403) throw e;
          if (e.status === 429) sawQuota = true;
          // Configuração recusada: tenta a mínima no mesmo modelo; senão, próximo modelo.
          if (e.status === 400 && variant === 'full') continue;
          console.info(`[Lärk web] Voz ao vivo: ${model} indisponível agora (${truncate(e.message, 120)}); tentando o próximo.`);
          break;
        }
      }
    }
    if (sawQuota) throw new LiveError('cota esgotada', 429);
    throw lastError ?? new LiveError('Nenhum modelo de voz ao vivo respondeu.', 404);
  }

  private discard(link: Link): void {
    link.discarded = true;
    link.alive = false;
    try {
      link.session?.close();
    } catch {
      /* já fechada */
    }
  }

  private dropLink(): void {
    if (this.link) this.discard(this.link);
    this.link = null;
    this.ready = false;
  }

  private onGeminiClose(link: Link, code: number, reason: string): void {
    link.alive = false;
    if (link.discarded || this.closed || link !== this.link) return;
    const status = statusFromClose(code, reason);
    if (status === 429) {
      this.fail('quota', QUOTA_MESSAGE);
      return;
    }
    // Sessões Live têm duração limitada: o cliente reconecta (abrindo outra sessão com o contexto salvo).
    this.send({ type: 'closed', reason: reason ? truncate(reason, 120) : 'sessão do Gemini encerrada' });
    this.shutdown(1000, 'gemini_closed');
  }

  private onGeminiMessage(link: Link, msg: LiveServerMessage): void {
    if (link.discarded || this.closed) return;
    if (msg.serverContent) this.onServerContent(msg.serverContent);
    if (msg.toolCall?.functionCalls?.length) void this.onToolCall(msg.toolCall.functionCalls);
    if (msg.goAway) {
      // O Gemini vai encerrar a sessão em breve: fecha num momento ocioso para o cliente reconectar.
      this.goAwayPending = true;
      if (this.isIdle()) this.closeForGoAway();
    }
  }

  private closeForGoAway(): void {
    if (this.closed) return;
    this.send({ type: 'closed', reason: 'tempo máximo da sessão ao vivo' });
    this.shutdown(1000, 'go_away');
  }

  private responseTurn(): TurnState {
    return this.finishing ?? this.turn;
  }

  private markResponding(turn: TurnState): void {
    if (turn.responding) return;
    turn.responding = true;
    if (!turn.userFinalSent) {
      turn.userFinalSent = true;
      const text = display(turn.userText);
      if (text) this.send({ type: 'user_transcript', text, final: true });
    }
  }

  private onServerContent(content: LiveServerContent): void {
    const input = content.inputTranscription;
    if (input?.text) this.onInputTranscription(input.text, Boolean(input.finished));

    const parts = content.modelTurn?.parts;
    if (parts?.length) {
      const turn = this.responseTurn();
      for (const part of parts) {
        const inline = part.inlineData;
        if (inline?.data && (!inline.mimeType || inline.mimeType.startsWith('audio/'))) {
          this.markResponding(turn);
          if (!this.closed) this.sink.audio(base64ToArrayBuffer(inline.data));
        } else if (part.text && !part.thought) {
          this.markResponding(turn);
          turn.modelText += part.text;
          if (!turn.assistantText) {
            const text = display(turn.modelText);
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
      const text = display(turn.assistantText);
      if (text) this.send({ type: 'assistant_transcript', text, final: false });
    }

    if (content.interrupted) this.onInterrupted();
    if (content.turnComplete) this.onTurnComplete();
  }

  private onInputTranscription(chunk: string, final: boolean): void {
    const turn = this.turn;
    if (final && isRewrite(turn.userText, chunk)) {
      // Versão final refinada da mesma fala: substitui em vez de concatenar.
      turn.userText = chunk;
    } else if (final && !turn.userText.trim() && this.finishing && isRewrite(this.finishing.userText, chunk)) {
      // Refinamento da fala do turno que o Lärk já está respondendo.
      this.finishing.userText = chunk;
      return;
    } else if (final && !turn.userText.trim() && this.lastSaved && Date.now() - this.lastSaved.at < 20_000 && isRewrite(this.lastSaved.text, chunk)) {
      // Refinamento que chegou depois do fim do turno: corrige a mensagem já salva.
      const text = clean(chunk);
      try {
        updateMessage(this.lastSaved.id, { content: text });
      } catch {
        /* armazenamento indisponível */
      }
      this.lastSaved.text = text;
      return;
    } else {
      turn.userText += chunk;
    }
    if (final) turn.userFinalSent = true;
    // Depois que o Lärk começou a responder, a legenda do usuário já foi fechada.
    if (turn.responding) return;
    const text = display(turn.userText);
    if (text) this.send({ type: 'user_transcript', text, final });
  }

  private splitTurn(): void {
    if (this.finishing) this.persistTurn(this.finishing);
    this.finishing = this.turn;
    this.turn = newTurn();
  }

  private onInterrupted(): void {
    this.send({ type: 'interrupted' });
    if (this.finishing) this.finishing.interrupted = true;
    else if (this.turn.responding) {
      this.turn.interrupted = true;
      this.splitTurn();
    }
  }

  private onTurnComplete(): void {
    const done = this.finishing ?? this.turn;
    if (this.finishing) this.finishing = null;
    else this.turn = newTurn();
    this.persistTurn(done);
    if (this.goAwayPending && this.isIdle()) this.closeForGoAway();
  }

  private isIdle(): boolean {
    return !this.finishing && !this.turn.responding && this.runningTools === 0 && !this.turn.userText.trim() && !this.turn.typedText;
  }

  private ensureConversation(): string {
    if (this.conversationId && getConversation(this.conversationId)) return this.conversationId;
    this.conversationId = getOrCreateActiveConversation().id;
    return this.conversationId;
  }

  /** Salva o turno (usuário + Lärk) como mensagens de voz e avisa o cliente. */
  private persistTurn(turn: TurnState, notify = true): void {
    const userText = clean(turn.typedText) || clean(turn.userText);
    let assistantText = clean(turn.assistantText) || clean(turn.modelText);
    if (assistantText && turn.interrupted && !/[.!?…]$/.test(assistantText)) assistantText += '…';
    const toolCalls = [...turn.toolCalls.values()];

    if (notify) {
      if (userText && !turn.userFinalSent) this.send({ type: 'user_transcript', text: userText, final: true });
      if (assistantText) this.send({ type: 'assistant_transcript', text: assistantText, final: true });
    }

    let userMessage: ChatMessage | null = null;
    let assistantMessage: ChatMessage | null = null;
    if (userText || assistantText || toolCalls.length) {
      try {
        const conversationId = this.ensureConversation();
        if (userText) {
          userMessage = addMessage({ conversationId, role: 'user', content: userText, kind: 'voice' });
          this.lastSaved = { id: userMessage.id, text: userText, at: Date.now() };
        }
        if (assistantText || toolCalls.length) {
          assistantMessage = addMessage({
            conversationId,
            role: 'assistant',
            content: assistantText,
            kind: 'voice',
            ...(toolCalls.length ? { toolCalls } : {}),
            // Garante a ordem usuário → Lärk mesmo no mesmo milissegundo.
            ...(userMessage ? { createdAt: new Date(Date.parse(userMessage.createdAt) + 1).toISOString() } : {}),
          });
        }
      } catch (e) {
        console.warn('[Lärk web] Voz ao vivo: não consegui salvar o turno —', e);
      }
    }
    if (notify) this.send({ type: 'turn_complete', userMessage, assistantMessage });
  }

  // ── Ferramentas ───────────────────────────────────────────────────────

  private async onToolCall(calls: FunctionCall[]): Promise<void> {
    const turn = this.responseTurn();
    this.markResponding(turn);
    this.runningTools++;
    try {
      const responses: FunctionResponse[] = [];
      for (const fc of calls) {
        const name = fc.name ?? '';
        const result = await runTool(name, fc.args ?? {}, {
          conversationId: this.ensureConversation(),
          emit: (call) => {
            turn.toolCalls.set(call.id, call);
            this.send({ type: 'tool', call });
          },
        });
        turn.toolCalls.set(result.call.id, result.call);
        responses.push({ ...(fc.id ? { id: fc.id } : {}), name, response: result.output });
      }
      if (responses.length && !this.closed) this.withSession((s) => s.sendToolResponse({ functionResponses: responses }));
    } finally {
      this.runningTools--;
      if (this.goAwayPending && this.isIdle()) this.closeForGoAway();
    }
  }
}
