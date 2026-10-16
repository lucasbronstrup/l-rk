/**
 * Reconhecimento de fala do navegador (Web Speech API) em pt-BR.
 * Usado no ditado do chat, no modo de voz clássico e na palavra de ativação.
 *
 * O navegador só permite uma sessão de reconhecimento ativa por vez: sessões "exclusivas"
 * (ditado, modo clássico) sinalizam ocupação para que a escuta da palavra de ativação ceda a vez.
 */

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

export type RecognitionErrorKind = 'denied' | 'no-mic' | 'network' | 'unsupported' | 'other';

export interface SpeechRecognizerOptions {
  lang?: string;
  /** Mantém a escuta após cada frase (reinicia sozinho quando o navegador encerra). */
  continuous?: boolean;
  /** Silêncio (ms) após o último resultado para considerar a fala encerrada. 0 = só no fim da sessão. */
  silenceMs?: number;
  /** Bloqueia a palavra de ativação enquanto ativo. */
  exclusive?: boolean;
  /** Texto provisório (inclui o já confirmado da frase atual). */
  onInterim?: (text: string) => void;
  /** Frase concluída (após silêncio ou fim da sessão). */
  onUtterance?: (text: string) => void;
  /** Resultado bruto (texto acumulado da sessão + se é final) — usado pela palavra de ativação. */
  onResult?: (text: string, isFinal: boolean) => void;
  onError?: (kind: RecognitionErrorKind, message: string) => void;
  onStateChange?: (listening: boolean) => void;
}

const ERROR_MESSAGES: Record<RecognitionErrorKind, string> = {
  denied: 'O acesso ao microfone foi negado. Libere a permissão no navegador para falar comigo.',
  'no-mic': 'Não encontrei um microfone funcionando.',
  network: 'O reconhecimento de voz do navegador precisa de internet e não conseguiu se conectar.',
  unsupported: 'Este navegador não reconhece fala. Use o Chrome ou o Edge para conversar por voz.',
  other: 'O reconhecimento de voz falhou. Tente novamente.',
};

/**
 * Envoltório robusto da Web Speech API: detecção de fim de fala por silêncio,
 * reinício automático em modo contínuo e tratamento de erros em pt-BR.
 */
export class SpeechRecognizer {
  private readonly opts: Required<Pick<SpeechRecognizerOptions, 'lang' | 'continuous' | 'silenceMs' | 'exclusive'>> &
    SpeechRecognizerOptions;
  private rec: RecognitionInstance | null = null;
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
    this.opts = { lang: 'pt-BR', continuous: false, silenceMs: 1200, exclusive: false, ...opts };
  }

  get listening(): boolean {
    return this.active;
  }

  start(): boolean {
    const Ctor = getCtor();
    if (!Ctor) {
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
    this.spawn(Ctor);
    return true;
  }

  /** Encerra entregando o que já foi reconhecido. */
  stop(): void {
    this.wanted = false;
    this.clearTimers();
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
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* já parado */
      }
    }
    this.setActive(false);
    this.releaseExclusive();
  }

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

  private handleError(ev: SpeechRecognitionErrorEvent) {
    switch (ev.error) {
      case 'no-speech':
      case 'aborted':
        return; // normais em escuta contínua
      case 'not-allowed':
      case 'service-not-allowed':
        this.fatal = true;
        this.wanted = false;
        this.opts.onError?.('denied', ERROR_MESSAGES.denied);
        return;
      case 'audio-capture':
        this.fatal = true;
        this.wanted = false;
        this.opts.onError?.('no-mic', ERROR_MESSAGES['no-mic']);
        return;
      case 'network':
        if (this.restarts >= 3) {
          this.fatal = true;
          this.wanted = false;
          this.opts.onError?.('network', ERROR_MESSAGES.network);
        }
        return;
      case 'language-not-supported':
        this.fatal = true;
        this.wanted = false;
        this.opts.onError?.('unsupported', ERROR_MESSAGES.unsupported);
        return;
      default:
        this.opts.onError?.('other', ERROR_MESSAGES.other);
    }
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
