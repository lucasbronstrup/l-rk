import { create } from 'zustand';
import type { ChatMessage, ToolCallInfo, VoiceClientMessage, VoiceServerMessage } from '@shared/types';
import { useChat } from '@/store/chat';
import { usePrefs } from '@/store/prefs';
import { useUi, type OrbState } from '@/store/ui';
import { playSfx } from '@/lib/sfx';
import { resumeAudioContext } from '@/lib/audio/context';
import { LEVEL_PRIORITY, setLevelSource } from '@/lib/audio/levels';
import { startMicCapture, toMicError, type MicCapture } from '@/lib/audio/mic';
import { PcmPlayer } from '@/lib/audio/player';
import { SpeechRecognizer, isVoiceInputSupported } from '@/lib/audio/recognition';
import { speak, stopSpeaking } from '@/lib/audio/speak';

/**
 * Sessão do modo de voz.
 *  - LIVE: WebSocket /api/voice (Gemini Live) com microfone PCM16 16 kHz e voz PCM16 24 kHz.
 *  - CLÁSSICO (reserva automática): reconhecimento do navegador → chat → TTS, em laço.
 *    Se o reconhecimento do navegador não existir ou não alcançar o serviço dele (Brave, Opera,
 *    redes restritas), a fala é gravada e transcrita pelo Gemini (POST /api/transcribe).
 * O estado é global (zustand) para que a palavra de ativação, a sobreposição e o chat conversem.
 */

export type VoiceEngine = 'live' | 'classic';
export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface VoiceNotice {
  tone: 'info' | 'warn' | 'error';
  text: string;
}

interface VoiceSessionState {
  active: boolean;
  engine: VoiceEngine | null;
  status: VoiceStatus;
  /** Modelo e voz informados pelo servidor no modo Live. */
  model: string | null;
  voice: string | null;
  muted: boolean;
  userCaption: string;
  userFinal: boolean;
  assistantCaption: string;
  assistantFinal: boolean;
  /** Ferramentas acionadas no turno atual. */
  tools: ToolCallInfo[];
  notice: VoiceNotice | null;

  start(opts?: { initialText?: string }): void;
  stop(): void;
  setMuted(muted: boolean): void;
  toggleMute(): void;
  /** Interrompe a fala do Lärk (barge-in manual). */
  interrupt(): void;
  /** Envia uma fala em texto (ex.: o restante da frase da palavra de ativação). */
  sendText(text: string): void;
  /** Guarda um texto para ser enviado assim que a sessão estiver pronta. */
  queueInitialText(text: string): void;
  dismissNotice(): void;
}

// ─── Runtime (fora do React) ──────────────────────────────────────────────

interface LiveRuntime {
  kind: 'live';
  token: number;
  ws: WebSocket;
  mic: MicCapture | null;
  player: PcmPlayer | null;
  ready: boolean;
  readyAt: number;
  closing: boolean;
  /** Após uma interrupção manual, descarta o áudio restante do turno. */
  dropAudio: boolean;
  /** O turno anterior terminou: a próxima transcrição começa legendas novas. */
  turnDone: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  unsubPrefs: (() => void) | null;
}

interface ClassicRuntime {
  kind: 'classic';
  token: number;
  recognizer: SpeechRecognizer | null;
  mic: MicCapture | null;
  busy: boolean;
  unsubChat: (() => void) | null;
}

type Runtime = LiveRuntime | ClassicRuntime;

const MIC_LEVEL = 'voice-mic';
const OUT_LEVEL = 'voice-out';
const READY_TIMEOUT_MS = 10_000;

let runtime: Runtime | null = null;
let sessionToken = 0;
let pendingText: string | null = null;
/** Reconexões automáticas do Live nesta sessão (sessões longas expiram no provedor). */
let liveReconnects = 0;
const MAX_LIVE_RECONNECTS = 2;

const isCurrent = (token: number) => token === sessionToken && useVoiceSession.getState().active;

function setOrb(state: OrbState) {
  const ui = useUi.getState();
  if (ui.orbState !== state) ui.setOrbState(state);
}

function send(rt: LiveRuntime, msg: VoiceClientMessage) {
  if (rt.ws.readyState === WebSocket.OPEN) rt.ws.send(JSON.stringify(msg));
}

const normCaption = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** O texto novo é uma versão revisada (pontuada/corrigida) do anterior, não uma continuação. */
function isRevision(prev: string, incoming: string): boolean {
  const a = normCaption(prev);
  const b = normCaption(incoming);
  if (a.length < 4 || b.length < a.length * 0.8 || b.length > a.length * 1.25) return false;
  let same = 0;
  const n = Math.min(a.length, b.length);
  while (same < n && a[same] === b[same]) same++;
  let tail = 0;
  while (tail < n - same && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return (same + tail) / Math.max(a.length, b.length) >= 0.6;
}

/** Junta pedaços de transcrição: aceita texto acumulado, incremental ou revisado. */
function mergeCaption(prev: string, incoming: string): string {
  if (!incoming) return prev;
  if (!prev) return incoming.trimStart();
  if (incoming.startsWith(prev)) return incoming;
  if (prev.endsWith(incoming)) return prev;
  if (isRevision(prev, incoming)) return incoming.trimStart();
  const needsSpace = !/\s$/.test(prev) && !/^[\s,.!?;:…]/.test(incoming);
  return needsSpace ? `${prev} ${incoming}` : prev + incoming;
}

const ERROR_NOTICES: Record<string, string> = {
  quota: 'A cota gratuita da voz ao vivo se esgotou por agora. Sigo no modo clássico — outra engrenagem, a mesma conversa.',
  no_api_key:
    'A voz ao vivo precisa da chave do Google AI Studio. Sigo no modo clássico; cole-a em Configurações → Inteligência para a experiência completa.',
  provider: 'O serviço de voz ao vivo do Gemini não respondeu bem. Sigo no modo clássico, sem perder o fio da conversa.',
  internal: 'O canal de voz ao vivo falhou. Sigo no modo clássico, sem perder o fio da conversa.',
};

/** Aviso ao cair para o modo clássico: a mensagem do servidor (já em PT-BR e acionável) quando houver. */
function liveErrorNotice(code: string | undefined, message: string | undefined): string {
  const base = ERROR_NOTICES[code ?? 'internal'] ?? ERROR_NOTICES.internal;
  const m = message?.trim();
  if (!m || m.length > 420 || /^(gemini live:|error|erro interno)/i.test(m)) return base;
  return /clássico/i.test(m) ? m : `${m} Enquanto isso, sigo no modo clássico.`;
}

// ─── Store ────────────────────────────────────────────────────────────────

export const useVoiceSession = create<VoiceSessionState>((set, get) => ({
  active: false,
  engine: null,
  status: 'idle',
  model: null,
  voice: null,
  muted: false,
  userCaption: '',
  userFinal: true,
  assistantCaption: '',
  assistantFinal: true,
  tools: [],
  notice: null,

  start(opts) {
    if (opts?.initialText) pendingText = opts.initialText;
    if (get().active) {
      if (pendingText) {
        const t = pendingText;
        pendingText = null;
        get().sendText(t);
      }
      return;
    }
    const token = ++sessionToken;
    liveReconnects = 0;
    stopSpeaking();
    set({
      active: true,
      engine: null,
      status: 'connecting',
      model: null,
      voice: null,
      muted: false,
      userCaption: '',
      userFinal: true,
      assistantCaption: '',
      assistantFinal: true,
      tools: [],
      notice: null,
    });
    setOrb('thinking');
    void startLive(token);
  },

  stop() {
    sessionToken++;
    pendingText = null;
    const rt = runtime;
    runtime = null;
    if (rt) teardown(rt);
    stopSpeaking();
    set({ active: false, engine: null, status: 'idle', muted: false, tools: [] });
    const ui = useUi.getState();
    if (ui.orbState === 'listening' || ui.orbState === 'thinking' || ui.orbState === 'speaking') ui.setOrbState('idle');
  },

  setMuted(muted) {
    if (get().muted === muted) return;
    set({ muted });
    const rt = runtime;
    if (!rt) return;
    if (rt.kind === 'live') {
      if (muted) rt.mic?.flush();
      rt.mic?.setMuted(muted);
      if (muted) send(rt, { type: 'audio_end' });
    } else {
      rt.mic?.setMuted(muted);
      if (muted) rt.recognizer?.abort();
      else if (!rt.busy) rt.recognizer?.start();
    }
  },

  toggleMute() {
    get().setMuted(!get().muted);
  },

  interrupt() {
    const rt = runtime;
    if (!rt) return;
    if (rt.kind === 'live') {
      if (rt.player?.playing) {
        rt.dropAudio = true;
        rt.player.interrupt();
      }
    } else {
      stopSpeaking();
    }
  },

  sendText(text) {
    const t = text.trim();
    if (!t) return;
    const rt = runtime;
    if (!rt || (rt.kind === 'live' && !rt.ready)) {
      pendingText = t;
      return;
    }
    if (rt.kind === 'live') {
      rt.player?.interrupt();
      rt.dropAudio = false;
      rt.turnDone = false;
      send(rt, { type: 'text', text: t });
      set({ userCaption: t, userFinal: true, assistantCaption: '', assistantFinal: false, tools: [], status: 'thinking' });
      setOrb('thinking');
    } else {
      void handleClassicUtterance(rt, t);
    }
  },

  queueInitialText(text) {
    const t = text.trim();
    if (t) pendingText = t;
  },

  dismissNotice() {
    set({ notice: null });
  },
}));

// ─── Modo Live ────────────────────────────────────────────────────────────

async function startLive(token: number): Promise<void> {
  if (typeof WebSocket === 'undefined') {
    return fallbackToClassic(token, 'Este navegador não suporta o canal de voz ao vivo. Sigo no modo clássico.');
  }
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    return fallbackToClassic(token, 'Não consegui abrir o canal de voz ao vivo. Sigo no modo clássico.');
  }
  ws.binaryType = 'arraybuffer';

  const rt: LiveRuntime = {
    kind: 'live',
    token,
    ws,
    mic: null,
    player: null,
    ready: false,
    readyAt: 0,
    closing: false,
    dropAudio: false,
    turnDone: true,
    readyTimer: null,
    unsubPrefs: null,
  };
  runtime = rt;

  rt.readyTimer = setTimeout(() => {
    if (!rt.ready && runtime === rt) {
      fallbackToClassic(token, 'O canal de voz ao vivo não respondeu a tempo. Sigo no modo clássico.');
    }
  }, READY_TIMEOUT_MS);

  ws.onopen = () => {
    if (runtime !== rt) return;
    send(rt, { type: 'start', conversationId: useChat.getState().conversationId });
  };
  ws.onmessage = (ev: MessageEvent<string | ArrayBuffer | Blob>) => {
    if (runtime !== rt) return;
    const data = ev.data;
    if (typeof data === 'string') {
      let msg: VoiceServerMessage;
      try {
        msg = JSON.parse(data) as VoiceServerMessage;
      } catch {
        return;
      }
      handleServerMessage(rt, msg);
    } else if (data instanceof ArrayBuffer) {
      handleAudio(rt, data);
    } else if (data instanceof Blob) {
      void data.arrayBuffer().then((buf) => runtime === rt && handleAudio(rt, buf));
    }
  };
  ws.onclose = () => {
    if (runtime !== rt || rt.closing) return;
    if (tryReconnectLive(rt)) return;
    fallbackToClassic(
      token,
      rt.ready
        ? 'A conexão de voz ao vivo caiu. Sigo no modo clássico, sem perder o fio da conversa.'
        : 'Não consegui abrir o canal de voz ao vivo. Sigo no modo clássico.',
    );
  };

  // Prepara áudio em paralelo à conexão.
  const ac = await resumeAudioContext();
  if (runtime !== rt) return;
  if (!ac) {
    return fallbackToClassic(token, 'Este navegador não suporta Web Audio para a voz ao vivo. Sigo no modo clássico.');
  }
  const player = new PcmPlayer(ac, 24000, usePrefs.getState().volume);
  rt.player = player;
  player.onPlayingChange = (playing) => onPlayerChange(rt, playing);
  rt.unsubPrefs = usePrefs.subscribe((s, prev) => {
    if (s.volume !== prev.volume) player.setVolume(s.volume);
  });

  try {
    const mic = await startMicCapture({
      onChunk: (pcm) => {
        if (rt.ready && !useVoiceSession.getState().muted && rt.ws.readyState === WebSocket.OPEN) rt.ws.send(pcm);
      },
    });
    if (runtime !== rt) {
      mic.stop();
      return;
    }
    rt.mic = mic;
    mic.setMuted(useVoiceSession.getState().muted);
    setLevelSource(MIC_LEVEL, mic.readLevel, LEVEL_PRIORITY.mic);
  } catch (e) {
    if (runtime !== rt) return;
    const err = toMicError(e);
    runtime = null;
    teardown(rt);
    useVoiceSession.setState({ status: 'error', notice: { tone: 'error', text: err.message } });
    setOrb('idle');
    playSfx('error');
  }
}

function handleAudio(rt: LiveRuntime, buf: ArrayBuffer) {
  if (rt.dropAudio || !rt.player) return;
  rt.player.enqueue(buf);
}

function onPlayerChange(rt: LiveRuntime, playing: boolean) {
  if (runtime !== rt) return;
  if (playing) {
    if (rt.player) setLevelSource(OUT_LEVEL, rt.player.readLevel, LEVEL_PRIORITY.speech);
    useVoiceSession.setState({ status: 'speaking' });
    setOrb('speaking');
  } else {
    setLevelSource(OUT_LEVEL, null);
    const s = useVoiceSession.getState();
    if (s.status === 'speaking') {
      useVoiceSession.setState({ status: 'listening' });
      setOrb('listening');
    }
  }
}

/**
 * Organiza as legendas por turno: fala do usuário depois de uma resposta abre um turno novo
 * (limpa tudo); resposta do Lärk depois de um turno concluído limpa só a legenda dele.
 */
function beginUserTurnIfNeeded(rt: LiveRuntime) {
  const s = useVoiceSession.getState();
  if (!rt.turnDone && !s.assistantCaption && s.tools.length === 0) return;
  rt.turnDone = false;
  rt.dropAudio = false;
  useVoiceSession.setState({ userCaption: '', userFinal: false, assistantCaption: '', assistantFinal: true, tools: [] });
}

function beginAssistantTurnIfNeeded(rt: LiveRuntime) {
  if (!rt.turnDone) return;
  rt.turnDone = false;
  rt.dropAudio = false;
  useVoiceSession.setState({ assistantCaption: '', assistantFinal: false, tools: [] });
}

function handleServerMessage(rt: LiveRuntime, msg: VoiceServerMessage) {
  const store = useVoiceSession;
  switch (msg.type) {
    case 'ready': {
      rt.ready = true;
      rt.readyAt = Date.now();
      if (rt.readyTimer) clearTimeout(rt.readyTimer);
      rt.readyTimer = null;
      store.setState((st) => ({
        engine: 'live',
        model: msg.model || null,
        voice: msg.voice || null,
        status: 'listening',
        notice: st.notice?.tone === 'info' ? null : st.notice,
      }));
      setOrb('listening');
      const chat = useChat.getState();
      if (msg.conversationId && chat.conversationId !== msg.conversationId) void chat.loadConversation(msg.conversationId);
      if (pendingText) {
        const t = pendingText;
        pendingText = null;
        store.getState().sendText(t);
      }
      break;
    }
    case 'user_transcript': {
      beginUserTurnIfNeeded(rt);
      const s = store.getState();
      store.setState({ userCaption: mergeCaption(s.userCaption, msg.text), userFinal: msg.final });
      if (msg.final && s.status !== 'speaking') {
        store.setState({ status: 'thinking' });
        setOrb('thinking');
      }
      break;
    }
    case 'assistant_transcript': {
      beginAssistantTurnIfNeeded(rt);
      const s = store.getState();
      store.setState({ assistantCaption: mergeCaption(s.assistantCaption, msg.text), assistantFinal: msg.final, userFinal: true });
      break;
    }
    case 'interrupted':
      rt.player?.interrupt();
      rt.dropAudio = false;
      store.setState({ status: 'listening', assistantFinal: true });
      setOrb('listening');
      break;
    case 'tool': {
      beginAssistantTurnIfNeeded(rt);
      const s = store.getState();
      const tools = [...s.tools];
      const i = tools.findIndex((c) => c.id === msg.call.id);
      if (i >= 0) tools[i] = { ...tools[i], ...msg.call };
      else tools.push(msg.call);
      store.setState({ tools, status: s.status === 'speaking' ? s.status : 'thinking' });
      if (s.status !== 'speaking') setOrb('thinking');
      break;
    }
    case 'turn_complete': {
      const saved = [msg.userMessage, msg.assistantMessage].filter((m): m is ChatMessage => Boolean(m));
      if (saved.length) useChat.getState().appendMessages(saved);
      rt.turnDone = true;
      rt.dropAudio = false;
      store.setState({ userFinal: true, assistantFinal: true });
      if (!rt.player?.playing) {
        store.setState({ status: 'listening' });
        setOrb('listening');
      }
      break;
    }
    case 'error': {
      if (msg.message) console.warn('[Lärk] Voz ao vivo:', msg.code, msg.message);
      fallbackToClassic(rt.token, liveErrorNotice(msg.code, msg.message));
      break;
    }
    case 'closed':
      if (!rt.closing && !tryReconnectLive(rt)) {
        fallbackToClassic(rt.token, `O canal de voz ao vivo foi encerrado${msg.reason ? ` (${msg.reason})` : ''}. Sigo no modo clássico.`);
      }
      break;
  }
}

/**
 * Sessões Live longas expiram no provedor: se a conversa já estava fluindo, reconecta
 * em silêncio (até MAX_LIVE_RECONNECTS vezes) antes de recorrer ao modo clássico.
 */
function tryReconnectLive(rt: LiveRuntime): boolean {
  if (!isCurrent(rt.token) || !rt.ready || Date.now() - rt.readyAt < 20_000 || liveReconnects >= MAX_LIVE_RECONNECTS) {
    return false;
  }
  liveReconnects++;
  runtime = null;
  teardown(rt);
  useVoiceSession.setState({ status: 'connecting', notice: { tone: 'info', text: 'Reconectando o canal de voz ao vivo…' } });
  setOrb('thinking');
  void startLive(rt.token);
  return true;
}

// ─── Modo clássico ────────────────────────────────────────────────────────

function fallbackToClassic(token: number, notice: string) {
  if (!isCurrent(token)) return;
  const rt = runtime;
  runtime = null;
  if (rt) teardown(rt);
  playSfx('alert');
  startClassic(token, notice);
}

function startClassic(token: number, notice: string | null) {
  const store = useVoiceSession;
  if (!isVoiceInputSupported(true)) {
    store.setState({
      engine: 'classic',
      status: 'error',
      model: null,
      voice: null,
      notice: {
        tone: 'error',
        text: `${notice ? `${notice} ` : ''}Porém este navegador não consegue ouvir o microfone por aqui. Abra o Lärk no Chrome ou no Edge — ou digite sua mensagem.`,
      },
    });
    setOrb('idle');
    return;
  }

  const rt: ClassicRuntime = { kind: 'classic', token, recognizer: null, mic: null, busy: false, unsubChat: null };
  runtime = rt;
  store.setState({
    engine: 'classic',
    model: null,
    voice: null,
    status: 'listening',
    notice: notice ? { tone: 'warn', text: notice } : null,
  });
  setOrb('listening');

  // Medidor de nível (opcional): dá vida ao orbe enquanto ouve.
  startMicCapture()
    .then((mic) => {
      if (runtime !== rt) return mic.stop();
      rt.mic = mic;
      mic.setMuted(store.getState().muted);
      setLevelSource(MIC_LEVEL, mic.readLevel, LEVEL_PRIORITY.mic);
    })
    .catch(() => undefined);

  rt.recognizer = new SpeechRecognizer({
    lang: 'pt-BR',
    continuous: true,
    silenceMs: 1100,
    exclusive: true,
    serverFallback: true,
    onPhase: (phase) => {
      if (rt.busy || runtime !== rt) return;
      if (phase === 'speech') {
        const s = store.getState();
        if (s.userFinal) store.setState({ userCaption: '', assistantCaption: '', assistantFinal: true, tools: [] });
        store.setState({ userFinal: false, status: 'listening' });
        setOrb('listening');
      } else if (phase === 'transcribing') {
        store.setState({ userCaption: 'Transcrevendo…', userFinal: false, status: 'thinking' });
        setOrb('thinking');
      } else {
        const s = store.getState();
        if (!s.userFinal) store.setState({ userCaption: '', userFinal: true });
        store.setState({ status: 'listening' });
        setOrb('listening');
      }
    },
    onInterim: (text) => {
      if (rt.busy || runtime !== rt) return;
      const s = store.getState();
      if (s.userFinal) store.setState({ assistantCaption: '', assistantFinal: true, tools: [] });
      store.setState({ userCaption: text, userFinal: false });
    },
    onUtterance: (text) => {
      if (runtime === rt) void handleClassicUtterance(rt, text);
    },
    onError: (kind, message) => {
      if (runtime !== rt) return;
      const fatal = kind === 'denied' || kind === 'no-mic' || kind === 'unsupported' || kind === 'network' || kind === 'no-key';
      store.setState({ notice: { tone: fatal ? 'error' : 'warn', text: message }, ...(fatal ? { status: 'error' as const } : {}) });
      if (fatal) {
        if (!store.getState().userFinal) store.setState({ userCaption: '', userFinal: true });
        setOrb('idle');
        playSfx('error');
      } else if (!rt.busy) {
        // Frase perdida na transcrição: volta a ouvir.
        const s = store.getState();
        if (!s.userFinal) store.setState({ userCaption: '', userFinal: true });
        store.setState({ status: 'listening' });
        setOrb('listening');
      }
    },
  });

  // Espelha a resposta em geração (texto e ferramentas) nas legendas.
  rt.unsubChat = useChat.subscribe((s) => {
    if (!rt.busy || runtime !== rt || !s.streamingId) return;
    const m = s.messages.find((x) => x.id === s.streamingId);
    if (!m) return;
    const cur = store.getState();
    if (cur.assistantCaption !== m.content || cur.tools !== (m.toolCalls ?? cur.tools)) {
      store.setState({ assistantCaption: m.content, tools: m.toolCalls ?? [] });
    }
  });

  if (pendingText) {
    const t = pendingText;
    pendingText = null;
    void handleClassicUtterance(rt, t);
  } else if (!store.getState().muted) {
    rt.recognizer.start();
  }
}

async function handleClassicUtterance(rt: ClassicRuntime, text: string): Promise<void> {
  const store = useVoiceSession;
  if (rt.busy || runtime !== rt) return;
  rt.busy = true;
  rt.recognizer?.abort();
  store.setState({
    userCaption: text,
    userFinal: true,
    assistantCaption: '',
    assistantFinal: false,
    tools: [],
    status: 'thinking',
  });
  setOrb('thinking');

  const before = useChat.getState().lastReply?.id ?? null;
  try {
    await useChat.getState().sendMessage(text, { kind: 'voice', speak: false });
    if (runtime !== rt) return;
    const chat = useChat.getState();
    const reply = chat.lastReply && chat.lastReply.id !== before ? chat.lastReply : null;
    if (reply && reply.content.trim()) {
      store.setState({ assistantCaption: reply.content, assistantFinal: true, tools: reply.toolCalls ?? [], status: 'speaking' });
      await speak(reply.content, { key: reply.id });
    } else if (chat.error) {
      store.setState({ notice: { tone: 'warn', text: chat.error }, assistantFinal: true });
    }
  } finally {
    if (runtime === rt) {
      rt.busy = false;
      store.setState({ status: 'listening', assistantFinal: true });
      setOrb('listening');
      if (!store.getState().muted) rt.recognizer?.start();
    }
  }
}

// ─── Encerramento ─────────────────────────────────────────────────────────

function teardown(rt: Runtime) {
  setLevelSource(MIC_LEVEL, null);
  setLevelSource(OUT_LEVEL, null);
  if (rt.kind === 'live') {
    rt.closing = true;
    if (rt.readyTimer) clearTimeout(rt.readyTimer);
    rt.unsubPrefs?.();
    try {
      send(rt, { type: 'stop' });
      if (rt.ws.readyState === WebSocket.OPEN || rt.ws.readyState === WebSocket.CONNECTING) rt.ws.close(1000, 'client_stop');
    } catch {
      /* conexão já encerrada */
    }
    rt.ws.onopen = null;
    rt.ws.onmessage = null;
    rt.ws.onclose = null;
    rt.mic?.stop();
    rt.player?.dispose();
  } else {
    rt.recognizer?.abort();
    rt.mic?.stop();
    rt.unsubChat?.();
  }
}
