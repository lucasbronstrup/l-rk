import { getAudioContext, resumeAudioContext } from './context';
import { analyserReader } from './pcm';

/** Erro de microfone com mensagem pronta para o usuário (pt-BR). */
export class MicError extends Error {
  readonly reason: 'unsupported' | 'insecure' | 'denied' | 'not_found' | 'busy' | 'unknown';
  constructor(reason: MicError['reason'], message: string) {
    super(message);
    this.name = 'MicError';
    this.reason = reason;
  }
}

export interface MicCapture {
  /** Nível atual 0..1 (0 quando silenciado). */
  readLevel: () => number;
  setMuted: (muted: boolean) => void;
  /** Envia o bloco PCM parcial ainda no worklet. */
  flush: () => void;
  stop: () => void;
}

export interface MicCaptureOptions {
  /** Recebe blocos PCM16 mono na taxa de destino. Sem callback, o microfone só mede o nível. */
  onChunk?: (pcm: ArrayBuffer) => void;
  targetRate?: number;
  chunkMs?: number;
}

const workletLoads = new WeakMap<AudioContext, Promise<void>>();

function loadCaptureWorklet(ac: AudioContext): Promise<void> {
  let p = workletLoads.get(ac);
  if (!p) {
    const base = import.meta.env?.BASE_URL ?? '/';
    const url = `${base.replace(/\/?$/, '/')}worklets/pcm-capture.js`;
    p = ac.audioWorklet.addModule(url);
    p.catch(() => workletLoads.delete(ac));
    workletLoads.set(ac, p);
  }
  return p;
}

/** Traduz falhas de getUserMedia em mensagens amigáveis. */
export function toMicError(e: unknown): MicError {
  if (e instanceof MicError) return e;
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicError('denied', 'Preciso de permissão para usar o microfone. Libere o acesso no navegador e tente de novo.');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new MicError('not_found', 'Não encontrei nenhum microfone conectado a este computador.');
    case 'NotReadableError':
    case 'AbortError':
      return new MicError('busy', 'O microfone está ocupado por outro aplicativo. Feche-o e tente novamente.');
    default:
      return new MicError('unknown', 'Não consegui acessar o microfone.');
  }
}

/** Solicita o microfone com cancelamento de eco, supressão de ruído e ganho automático. */
export async function requestMicStream(): Promise<MediaStream> {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    throw new MicError('insecure', 'O microfone só funciona em conexão segura (HTTPS) ou em localhost.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicError('unsupported', 'Este navegador não oferece acesso ao microfone.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (e) {
    throw toMicError(e);
  }
}

/**
 * Inicia a captura do microfone: mede o nível (AnalyserNode) e, se `onChunk` for informado,
 * envia PCM16 mono na taxa de destino via AudioWorklet.
 */
export async function startMicCapture(opts: MicCaptureOptions = {}): Promise<MicCapture> {
  const ac = getAudioContext();
  if (!ac) throw new MicError('unsupported', 'Este navegador não suporta Web Audio.');
  if (opts.onChunk && !ac.audioWorklet) {
    throw new MicError('insecure', 'A captura de voz exige conexão segura (HTTPS) ou localhost.');
  }

  const stream = await requestMicStream();
  await resumeAudioContext();

  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let node: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  let muted = false;
  let stopped = false;

  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());

  try {
    source = ac.createMediaStreamSource(stream);
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    if (opts.onChunk) {
      await loadCaptureWorklet(ac);
      const onChunk = opts.onChunk;
      node = new AudioWorkletNode(ac, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate: opts.targetRate ?? 16000, chunkMs: opts.chunkMs ?? 40 },
      });
      node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        if (stopped || muted || !(ev.data instanceof ArrayBuffer)) return;
        onChunk(ev.data);
      };
      // O worklet precisa estar ligado ao destino para ser processado; ganho zero = silêncio.
      sink = ac.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ac.destination);
    }
  } catch (e) {
    stopTracks();
    source?.disconnect();
    throw e instanceof MicError ? e : new MicError('unknown', 'Falha ao preparar a captura de áudio do microfone.');
  }

  const read = analyserReader(analyser);

  return {
    readLevel: () => (muted || stopped ? 0 : read()),
    setMuted: (m) => {
      muted = m;
      stream.getAudioTracks().forEach((t) => (t.enabled = !m));
    },
    flush: () => node?.port.postMessage({ type: 'flush' }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        node?.port.postMessage({ type: 'stop' });
        node?.port.close();
        node?.disconnect();
        sink?.disconnect();
        analyser?.disconnect();
        source?.disconnect();
      } catch {
        /* nós já desconectados */
      }
      stopTracks();
    },
  };
}
