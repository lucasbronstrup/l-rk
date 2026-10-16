/**
 * Reconhecimento de fala em pt-BR.
 * Usado no ditado do chat, no modo de voz clássico e na palavra de ativação.
 *
 *  - Principal: Web Speech API do navegador.
 *  - Reserva (opcional, `serverFallback`): quando a Web Speech API não existe ou não alcança o
 *    serviço dela (erro 'network' no Brave/Opera/Edge e em redes restritas), grava a fala com
 *    MediaRecorder + detecção de silêncio e transcreve pelo Gemini em POST /api/transcribe.
 *
 * O navegador só permite uma sessão de reconhecimento ativa por vez: sessões "exclusivas"
 * (ditado, modo clássico) sinalizam ocupação para que a escuta da palavra de ativação ceda a vez.
 */
import { getAudioContext, resumeAudioContext } from './context';
import { requestMicStream, toMicError } from './mic';
interface RecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((ev: Event) => void) | null;
  onstart: ((ev: Event) => void) | null;
  onspeechstart: ((ev: Event) => void) | null;
  onspeechend: ((ev: Event) => void) | null;
}

type RecognitionCtor = new () => RecognitionInstance;

function getCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getCtor() !== null;
}

// ─── Exclusividade ────────────────────────────────────────────────────────

let exclusiveCount = 0;
const exclusiveListeners = new Set<(busy: boolean) => void>();

/** Notifica quando alguma sessão exclusiva começa/termina (true = ocupado). */
export function onRecognitionBusyChange(fn: (busy: boolean) => void): () => void {
  exclusiveListeners.add(fn);
  return () => exclusiveListeners.delete(fn);
}

export function isRecognitionBusy(): boolean {
  return exclusiveCount > 0;
}

function changeExclusive(delta: 1 | -1) {
  const before = exclusiveCount > 0;
  exclusiveCount = Math.max(0, exclusiveCount + delta);
  const after = exclusiveCount > 0;
  if (before !== after) exclusiveListeners.forEach((fn) => fn(after));
}

// ─── Reconhecedor ─────────────────────────────────────────────────────────

/**
 * - denied/no-mic: microfone negado/ausente;
 * - network: o serviço de fala do navegador não responde e não há reserva disponível;
 * - unsupported: sem Web Speech API e sem reserva;
 * - no-key: a reserva pelo Gemini precisa da chave (fatal até configurar);
 * - service: a transcrição de reserva falhou nesta frase (não fatal);
 * - other: falha genérica.
 */
export type RecognitionErrorKind = 'denied' | 'no-mic' | 'network' | 'unsupported' | 'no-key' | 'service' | 'other';

/** Fases da reserva por gravação: ouvindo silêncio, captando fala, transcrevendo. */
export type RecognitionPhase = 'idle' | 'speech' | 'transcribing';

export interface SpeechRecognizerOptions {
  lang?: string;
  /** Mantém a escuta após cada frase (reinicia sozinho quando o navegador encerra). */
  continuous?: boolean;
  /** Silêncio (ms) após o último resultado para considerar a fala encerrada. 0 = só no fim da sessão. */
  silenceMs?: number;
  /** Bloqueia a palavra de ativação enquanto ativo. */
  exclusive?: boolean;
  /**
   * Usa a transcrição pelo Gemini (POST /api/transcribe) quando a Web Speech API não existir
   * ou falhar de forma irrecuperável. Desligado por padrão: a escuta contínua da palavra de
   * ativação não deve gastar cota de transcrição.
   */
  serverFallback?: boolean;
  /** Texto provisório (inclui o já confirmado da frase atual). */
  onInterim?: (text: string) => void;
  /** Frase concluída (após silêncio ou fim da sessão). */
  onUtterance?: (text: string) => void;
  /** Resultado bruto (texto acumulado da sessão + se é final) — usado pela palavra de ativação. */
  onResult?: (text: string, isFinal: boolean) => void;
  onError?: (kind: RecognitionErrorKind, message: string) => void;
  onStateChange?: (listening: boolean) => void;
  /** Só na reserva por gravação: fala detectada / transcrevendo / de volta ao silêncio. */
  onPhase?: (phase: RecognitionPhase) => void;
}

const ERROR_MESSAGES: Record<RecognitionErrorKind, string> = {
  denied: 'O acesso ao microfone foi negado. Clique no cadeado da barra de endereço, permita o microfone e abra o modo de voz de novo.',
  'no-mic': 'Não encontrei um microfone funcionando. Conecte um microfone (ou confira se outro aplicativo está usando) e tente de novo.',
  network:
    'O reconhecimento de voz deste navegador não alcança o serviço de fala dele (acontece no Brave, no Opera e em redes que bloqueiam o Google). Abra no Chrome, ou atualize o Lärk no computador para eu transcrever sua voz pelo Gemini. Enquanto isso, digite sua mensagem.',
  unsupported:
    'Este navegador não reconhece fala. Use o Chrome ou o Edge — ou atualize o Lärk no computador para eu transcrever sua voz pelo Gemini. Enquanto isso, digite sua mensagem.',
  'no-key':
    'Para eu entender sua voz neste navegador, cole sua chave gratuita do Google AI Studio em Configurações → Inteligência. Enquanto isso, digite sua mensagem.',
  service: 'Não consegui transcrever essa frase. Fale de novo, por favor.',
  other: 'O reconhecimento de voz falhou. Tente novamente.',
};

/** O serviço de fala do navegador falhou nesta página: as próximas sessões já começam pela reserva. */
let browserServiceBroken = false;
/** O servidor não tem POST /api/transcribe (404/501): a reserva fica indisponível. */
let transcribeUnavailable = false;

/** A reserva por gravação + transcrição pelo Gemini é possível neste navegador. */
export function isTranscribeFallbackSupported(): boolean {
  if (typeof window === 'undefined' || transcribeUnavailable) return false;
  return (
    window.isSecureContext !== false &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    getAudioContext() !== null
  );
}

/** Há algum jeito de ouvir o usuário (Web Speech API ou, com `serverFallback`, a reserva). */
export function isVoiceInputSupported(serverFallback = true): boolean {
  return isSpeechRecognitionSupported() || (serverFallback && isTranscribeFallbackSupported());
}

/**
 * Envoltório robusto da Web Speech API: detecção de fim de fala por silêncio,
 * reinício automático em modo contínuo, tratamento de erros em pt-BR e, se habilitada,
 * troca transparente para a transcrição pelo Gemini quando o serviço do navegador falha.
 */
export class SpeechRecognizer {
  private readonly opts: Required<Pick<SpeechRecognizerOptions, 'lang' | 'continuous' | 'silenceMs' | 'exclusive' | 'serverFallback'>> &
    SpeechRecognizerOptions;
  private rec: RecognitionInstance | null = null;
  private recorder: VadRecorder | null = null;
  private wanted = false;
  private active = false;
  private holdingExclusive = false;
  private finalText = '';
  private interimText = '';
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  private fatal = false;

  constructor(opts: SpeechRecognizerOptions = {}) {
    this.opts = { lang: 'pt-BR', continuous: false, silenceMs: 1200, exclusive: false, serverFallback: false, ...opts };
  }

  get listening(): boolean {
    return this.active;
  }

  /** true quando está usando (ou usará) a transcrição pelo Gemini em vez do navegador. */
  get usingServerFallback(): boolean {
    return this.recorder !== null || this.shouldUseRecording();
  }

  private shouldUseRecording(): boolean {
    return this.opts.serverFallback && (!getCtor() || browserServiceBroken) && isTranscribeFallbackSupported();
  }

  start(): boolean {
    const Ctor = getCtor();
    const useRecording = this.shouldUseRecording();
    if (!Ctor && !useRecording) {
      this.opts.onError?.('unsupported', ERROR_MESSAGES.unsupported);
      return false;
    }
    this.wanted = true;
    this.fatal = false;
    this.restarts = 0;
    this.resetUtterance();
    if (this.opts.exclusive && !this.holdingExclusive) {
      this.holdingExclusive = true;
      changeExclusive(1);
    }
    if (useRecording || !Ctor) this.startRecording();
    else this.spawn(Ctor);
    return true;
  }

  /** Encerra entregando o que já foi reconhecido. */
  stop(): void {
    this.wanted = false;
    this.clearTimers();
    if (this.recorder) {
      // Entrega a fala em curso (se houver) e encerra quando a transcrição terminar.
      this.recorder.finish();
      this.releaseExclusive();
      return;
    }
    this.commit();
    try {
      this.rec?.stop();
    } catch {
      /* já parado */
    }
    this.releaseExclusive();
  }

  /** Encerra descartando o texto pendente. */
  abort(): void {
    this.wanted = false;
    this.clearTimers();
    this.resetUtterance();
    this.detachWebRecognition();
    const recorder = this.recorder;
    this.recorder = null;
    recorder?.abort();
    this.setActive(false);
    this.releaseExclusive();
  }

  private detachWebRecognition() {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      /* já parado */
    }
  }

  // ── Web Speech API ──────────────────────────────────────────────────────

  private spawn(Ctor: RecognitionCtor) {
    const rec = new Ctor();
    rec.lang = this.opts.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;

    rec.onstart = () => this.setActive(true);
    rec.onresult = (ev) => this.handleResult(ev);
    rec.onerror = (ev) => this.handleError(ev);
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      this.setActive(false);
      // O navegador encerrou (silêncio longo, rede...): entrega o pendente e, se contínuo, reinicia.
      this.commit();
      if (this.wanted && this.opts.continuous && !this.fatal) {
        const delay = Math.min(4000, 250 * 2 ** Math.min(this.restarts, 4));
        this.restarts++;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.wanted) this.spawn(Ctor);
        }, delay);
      } else {
        this.wanted = false;
        this.releaseExclusive();
      }
    };

    try {
      rec.start();
    } catch {
      // "already started" — outra instância ainda finalizando; tenta de novo em instantes.
      this.rec = null;
      if (this.wanted) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.wanted) this.spawn(Ctor);
        }, 400);
      }
    }
  }

  private handleResult(ev: SpeechRecognitionEvent) {
    this.restarts = 0;
    let interim = '';
    let finalChunk = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      const text = res[0]?.transcript ?? '';
      if (res.isFinal) finalChunk += text;
      else interim += text;
    }
    if (finalChunk) this.finalText = joinText(this.finalText, finalChunk);
    this.interimText = interim.trim();
    const combined = joinText(this.finalText, this.interimText);
    this.opts.onInterim?.(combined);
    this.opts.onResult?.(combined, interim === '');

    if (this.opts.silenceMs > 0 && this.opts.onUtterance) {
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null;
        this.commit();
      }, this.opts.silenceMs);
    }
  }

  /** Troca para a reserva pelo Gemini quando o serviço do navegador falha de vez. */
  private switchToRecording(rememberBroken: boolean): boolean {
    if (!this.opts.serverFallback || !isTranscribeFallbackSupported()) return false;
    if (rememberBroken) browserServiceBroken = true;
    console.info('[Lärk] Reconhecimento do navegador indisponível; usando a transcrição pelo Gemini.');
    this.clearTimers();
    this.commit();
    this.detachWebRecognition();
    this.setActive(false);
    if (this.wanted) this.startRecording();
    return true;
  }

  private handleError(ev: SpeechRecognitionErrorEvent) {
    switch (ev.error) {
      case 'no-speech':
      case 'aborted':
        return; // normais em escuta contínua
      case 'not-allowed':
        this.fatal = true;
        this.wanted = false;
        this.opts.onError?.('denied', ERROR_MESSAGES.denied);
        return;
      case 'service-not-allowed':
        // O navegador desativou o serviço de fala (políticas, Brave, Safari sem Siri...).
        if (this.switchToRecording(true)) return;
        this.fatal = true;
        this.wanted = false;
        this.opts.onError?.('denied', ERROR_MESSAGES.denied);
        return;
      case 'audio-capture':
        if (this.switchToRecording(false)) return;
        this.fatal = true;
        this.wanted = false;
        this.opts.onError?.('no-mic', ERROR_MESSAGES['no-mic']);
        return;
      case 'network':
        if (this.switchToRecording(true)) return;
        if (this.restarts >= 3) {
          this.fatal = true;
          this.wanted = false;
          this.opts.onError?.('network', ERROR_MESSAGES.network);
        }
        return;
      case 'language-not-supported':
        if (this.switchToRecording(false)) return;
        this.fatal = true;
        this.wanted = false;
        this.opts.onError?.('unsupported', ERROR_MESSAGES.unsupported);
        return;
      default:
        this.opts.onError?.('other', ERROR_MESSAGES.other);
    }
  }

  // ── Reserva: gravação + transcrição pelo Gemini ─────────────────────────

  private startRecording() {
    if (this.recorder) return;
    const recorder = new VadRecorder({
      continuous: this.opts.continuous,
      onPhase: (phase) => {
        if (this.recorder !== recorder) return;
        this.opts.onPhase?.(phase);
      },
      onText: (text) => {
        if (this.recorder !== recorder) return;
        this.opts.onResult?.(text, true);
        this.opts.onUtterance?.(text);
      },
      onError: (kind, message) => {
        if (this.recorder !== recorder) return;
        const fatal = kind !== 'service';
        if (fatal) {
          this.fatal = true;
          this.wanted = false;
          this.recorder = null;
          recorder.abort();
          this.setActive(false);
          this.releaseExclusive();
        }
        this.opts.onError?.(kind, message || ERROR_MESSAGES[kind]);
      },
      onEnd: () => {
        if (this.recorder !== recorder) return;
        this.recorder = null;
        this.wanted = false;
        this.setActive(false);
        this.releaseExclusive();
      },
    });
    this.recorder = recorder;
    void recorder.start().then((ok) => {
      if (ok && this.recorder === recorder) this.setActive(true);
    });
  }

  /** Entrega a frase acumulada (se houver) e zera o acumulador. */
  private commit() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    const text = joinText(this.finalText, this.interimText).trim();
    this.resetUtterance();
    if (text) this.opts.onUtterance?.(text);
  }

  private resetUtterance() {
    this.finalText = '';
    this.interimText = '';
  }

  private clearTimers() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.silenceTimer = null;
    this.restartTimer = null;
  }

  private setActive(v: boolean) {
    if (this.active === v) return;
    this.active = v;
    this.opts.onStateChange?.(v);
  }

  private releaseExclusive() {
    if (this.holdingExclusive) {
      this.holdingExclusive = false;
      changeExclusive(-1);
    }
  }
}

// ─── Gravação com detecção de fala (reserva) ──────────────────────────────

const VAD_TICK_MS = 40;
/** Silêncio que encerra a frase. */
const END_SILENCE_MS = 900;
/** Duração máxima de uma frase. */
const MAX_UTTERANCE_MS = 30_000;
/** Fala mais curta que isso é tratada como ruído (estalo, tosse). */
const MIN_SPEECH_MS = 220;
/** Gravador ocioso é reciclado para manter só alguns segundos de "pré-fala" (início da primeira sílaba). */
const IDLE_RECYCLE_MS = 4_000;
/** RMS mínimo (0..1) para considerar fala, mesmo em ambiente muito silencioso. */
const MIN_START_RMS = 0.012;

interface VadRecorderOptions {
  continuous: boolean;
  onPhase(phase: RecognitionPhase): void;
  onText(text: string): void;
  onError(kind: RecognitionErrorKind, message: string): void;
  onEnd(): void;
}

function pickRecorderMime(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* navegador sem isTypeSupported */
    }
  }
  return undefined;
}

/**
 * Ouve o microfone com um AnalyserNode: quando o RMS passa do limiar a fala começa; após
 * ~900 ms de silêncio (ou 30 s) ela termina, e o trecho gravado pelo MediaRecorder vai para
 * POST /api/transcribe. Um gravador fica sempre rodando (reciclado a cada poucos segundos de
 * silêncio) para que o início da fala não se perca.
 */
class VadRecorder {
  private readonly o: VadRecorderOptions;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recorderStartedAt = 0;
  private mime: string | undefined;
  private stopped = false;
  private finishing = false;
  private speaking = false;
  private speechStartAt = 0;
  private lastVoiceAt = 0;
  private aboveCount = 0;
  private noiseFloor = 0.004;
  private transcribing = 0;
  private aborter = new AbortController();

  constructor(o: VadRecorderOptions) {
    this.o = o;
  }

  async start(): Promise<boolean> {
    try {
      this.stream = await requestMicStream();
    } catch (e) {
      if (this.stopped) return false;
      const err = toMicError(e);
      this.o.onError(err.reason === 'denied' || err.reason === 'insecure' ? 'denied' : 'no-mic', err.message);
      return false;
    }
    if (this.stopped) {
      this.releaseStream();
      return false;
    }
    const ac = await resumeAudioContext();
    if (!ac || this.stopped) {
      this.releaseStream();
      if (!this.stopped) this.o.onError('unsupported', ERROR_MESSAGES.unsupported);
      return false;
    }
    try {
      this.source = ac.createMediaStreamSource(this.stream);
      this.analyser = ac.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0;
      this.source.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);
      this.mime = pickRecorderMime();
      this.startRecorder();
    } catch {
      this.cleanup();
      this.o.onError('unsupported', ERROR_MESSAGES.unsupported);
      return false;
    }
    this.timer = setInterval(() => this.tick(), VAD_TICK_MS);
    return true;
  }

  /** Para de ouvir; a fala em curso ainda é transcrita e entregue. */
  finish(): void {
    if (this.stopped || this.finishing) return;
    this.finishing = true;
    if (this.speaking) this.endUtterance(Date.now());
    this.stopListening();
    if (this.transcribing === 0) this.end();
  }

  /** Para tudo e descarta o pendente. */
  abort(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.aborter.abort();
    this.cleanup();
  }

  private end() {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
    this.o.onEnd();
  }

  private startRecorder() {
    if (!this.stream || this.stopped) return;
    const rec = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    this.recorder = rec;
    this.chunks = chunks;
    this.recorderStartedAt = Date.now();
    rec.start();
  }

  /** Encerra o gravador atual e devolve o áudio dele. */
  private stopRecorder(): Promise<Blob | null> {
    const rec = this.recorder;
    const chunks = this.chunks;
    this.recorder = null;
    this.chunks = [];
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || this.mime || 'audio/webm' }) : null);
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
  }

  private rms(): number {
    if (!this.analyser || !this.buf) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return Math.sqrt(sum / this.buf.length);
  }

  private tick() {
    if (this.stopped || this.finishing) return;
    const now = Date.now();
    const level = this.rms();
    const startThreshold = Math.max(MIN_START_RMS, this.noiseFloor * 3.2);
    const keepThreshold = startThreshold * 0.6;

    if (!this.speaking) {
      if (level > startThreshold) {
        this.aboveCount++;
        if (this.aboveCount >= 2) {
          this.speaking = true;
          this.speechStartAt = now - VAD_TICK_MS * 2;
          this.lastVoiceAt = now;
          this.o.onPhase('speech');
        }
      } else {
        this.aboveCount = 0;
        // Acompanha o ruído de fundo devagar (só enquanto ninguém fala).
        this.noiseFloor = this.noiseFloor * 0.97 + Math.min(level, 0.05) * 0.03;
        if (now - this.recorderStartedAt > IDLE_RECYCLE_MS) {
          void this.stopRecorder();
          this.startRecorder();
        }
      }
      return;
    }

    if (level > keepThreshold) this.lastVoiceAt = now;
    if (now - this.lastVoiceAt >= END_SILENCE_MS || now - this.speechStartAt >= MAX_UTTERANCE_MS) this.endUtterance(now);
  }

  private endUtterance(now: number) {
    this.speaking = false;
    this.aboveCount = 0;
    const voiced = this.lastVoiceAt - this.speechStartAt;
    const blobPromise = this.stopRecorder();
    if (!this.finishing && !this.stopped) this.startRecorder();
    if (voiced < MIN_SPEECH_MS && now - this.speechStartAt < MAX_UTTERANCE_MS) {
      this.o.onPhase('idle');
      return;
    }
    // Uma frase de cada vez: no modo não contínuo (ditado), para de ouvir após a primeira.
    if (!this.o.continuous) this.stopListening();
    this.transcribing++;
    this.o.onPhase('transcribing');
    void blobPromise
      .then((blob) => (blob ? transcribeAudio(blob, this.aborter.signal) : ''))
      .then(
        (text) => {
          if (this.stopped) return;
          if (text) this.o.onText(text);
        },
        (e: unknown) => {
          if (this.stopped) return;
          const err = e instanceof TranscribeError ? e : new TranscribeError('service', ERROR_MESSAGES.service);
          this.o.onError(err.kind, err.message);
        },
      )
      .finally(() => {
        this.transcribing--;
        if (this.stopped) return;
        if (this.transcribing === 0) {
          if (this.finishing || !this.o.continuous) this.end();
          else this.o.onPhase(this.speaking ? 'speech' : 'idle');
        }
      });
  }

  private stopListening() {
    if (!this.o.continuous || this.finishing) this.finishing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.stopRecorder();
    this.releaseStream();
  }

  private releaseStream() {
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* já desconectados */
    }
    this.source = null;
    this.analyser = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private cleanup() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const rec = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (rec && rec.state !== 'inactive') {
      try {
        rec.onstop = null;
        rec.stop();
      } catch {
        /* já parado */
      }
    }
    this.releaseStream();
  }
}

// ─── Transcrição (POST /api/transcribe) ───────────────────────────────────

class TranscribeError extends Error {
  readonly kind: RecognitionErrorKind;
  constructor(kind: RecognitionErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Converte o áudio gravado em WAV PCM16 mono 16 kHz (formato aceito por qualquer servidor). */
async function toWav16k(blob: Blob): Promise<Blob> {
  const Offline = (window as Window & { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  const ac = getAudioContext();
  if (!Offline || !ac) return blob;
  try {
    const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const length = Math.max(1, Math.ceil(decoded.duration * rate));
    const offline = new Offline(1, length, rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const write = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
    };
    write(0, 'RIFF');
    out.setUint32(4, 36 + samples.length * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, rate, true);
    out.setUint32(28, rate * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    write(36, 'data');
    out.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  } catch {
    return blob;
  }
}

/** Envia o áudio para POST /api/transcribe e devolve o texto reconhecido. */
export async function transcribeAudio(blob: Blob, signal?: AbortSignal): Promise<string> {
  const audio = await toWav16k(blob);
  let res: Response;
  try {
    res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/webm' },
      body: audio,
      credentials: 'include',
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new TranscribeError('service', 'Não consegui enviar sua fala para transcrição. Confira a conexão e fale de novo.');
  }
  if (res.status === 404 || res.status === 501 || res.status === 405) {
    transcribeUnavailable = true;
    throw new TranscribeError('network', ERROR_MESSAGES.network);
  }
  let body: { text?: unknown; error?: unknown; code?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* corpo ilegível */
  }
  if (!res.ok) {
    const message = typeof body.error === 'string' && body.error ? body.error : ERROR_MESSAGES.service;
    const code = typeof body.code === 'string' ? body.code : '';
    if (code === 'no_api_key') throw new TranscribeError('no-key', message);
    if (res.status === 401) throw new TranscribeError('denied', 'Sua sessão no Lärk expirou. Entre novamente para falar comigo.');
    throw new TranscribeError('service', message);
  }
  return typeof body.text === 'string' ? body.text.trim() : '';
}

function joinText(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (!x) return y;
  if (!y) return x;
  return `${x} ${y}`;
}

/** Remove acentos e pontuação para comparações tolerantes (ex.: "Lärk," → "lark"). */
export function normalizeSpeech(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
