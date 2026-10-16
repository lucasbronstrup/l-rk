/** Utilidades de áudio PCM e medição de nível. */

/** Converte PCM16 little-endian (ArrayBuffer ou view) em Float32 [-1, 1]. */
export function pcm16ToFloat32(data: ArrayBuffer | ArrayBufferView): Float32Array<ArrayBuffer> {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const samples = bytes.byteLength >> 1;
  const out = new Float32Array(samples);
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true);
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/** Converte Float32 [-1, 1] em PCM16 (Int16Array little-endian na plataforma web). */
export function float32ToPcm16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Mapeia RMS linear para um nível perceptual 0..1 (-60 dBFS → 0, -12 dBFS → 1). */
export function rmsToLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0.00001) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 48));
}

/** Cria uma função que lê o nível atual (0..1) de um AnalyserNode. */
export function analyserReader(analyser: AnalyserNode): () => number {
  const buf = new Float32Array(analyser.fftSize);
  return () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return rmsToLevel(Math.sqrt(sum / buf.length));
  };
}
