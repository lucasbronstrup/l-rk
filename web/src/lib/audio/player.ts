import { analyserReader, pcm16ToFloat32 } from './pcm';

/**
 * Player de PCM16 em fluxo (voz do modo Live, 24 kHz).
 * Agenda AudioBufferSourceNodes em sequência exata, sem lacunas, e pode ser interrompido
 * instantaneamente (barge-in).
 */
export class PcmPlayer {
  private readonly ctx: AudioContext;
  private readonly sampleRate: number;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private leftover: Uint8Array | null = null;
  private isPlaying = false;
  private disposed = false;
  private readonly reader: () => number;

  /** Chamado quando a reprodução começa (true) ou esvazia (false). */
  onPlayingChange: ((playing: boolean) => void) | null = null;

  constructor(ctx: AudioContext, sampleRate = 24000, volume = 1) {
    this.ctx = ctx;
    this.sampleRate = sampleRate;
    this.gain = ctx.createGain();
    this.gain.gain.value = clampVolume(volume);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.3;
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.reader = analyserReader(this.analyser);
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  /** Nível atual da voz em reprodução (0..1). */
  readLevel = (): number => (this.isPlaying ? this.reader() : 0);

  setVolume(volume: number): void {
    this.gain.gain.setTargetAtTime(clampVolume(volume), this.ctx.currentTime, 0.02);
  }

  /** Enfileira um bloco PCM16 LE mono. Bytes ímpares são guardados para o próximo bloco. */
  enqueue(chunk: ArrayBuffer): void {
    if (this.disposed || chunk.byteLength === 0) return;
    let bytes = new Uint8Array(chunk);
    if (this.leftover) {
      const merged = new Uint8Array(this.leftover.length + bytes.length);
      merged.set(this.leftover);
      merged.set(bytes, this.leftover.length);
      bytes = merged;
      this.leftover = null;
    }
    if (bytes.length % 2 === 1) {
      this.leftover = bytes.slice(bytes.length - 1);
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length === 0) return;

    const samples = pcm16ToFloat32(bytes);
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);

    const now = this.ctx.currentTime;
    // Pequena folga inicial absorve a variação de chegada dos pacotes pela rede.
    if (this.nextTime < now + 0.02) this.nextTime = now + 0.08;
    src.start(this.nextTime);
    this.nextTime += buffer.duration;

    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      try {
        src.disconnect();
      } catch {
        /* já desconectado */
      }
      if (this.sources.size === 0) this.setPlaying(false);
    };
    this.setPlaying(true);
  }

  /** Para tudo imediatamente e descarta o que estava agendado. */
  interrupt(): void {
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* nó já encerrado */
      }
    }
    this.sources.clear();
    this.leftover = null;
    this.nextTime = 0;
    this.setPlaying(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.interrupt();
    this.disposed = true;
    this.onPlayingChange = null;
    try {
      this.gain.disconnect();
      this.analyser.disconnect();
    } catch {
      /* já desconectado */
    }
  }

  private setPlaying(v: boolean) {
    if (this.isPlaying === v) return;
    this.isPlaying = v;
    this.onPlayingChange?.(v);
  }
}

function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}
