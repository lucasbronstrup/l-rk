/**
 * Utilitários de áudio PCM/WAV para a voz do Lärk.
 *
 * O Gemini TTS devolve o áudio em dois formatos, conforme o modelo:
 *  - `audio/wav` já com cabeçalho RIFF (ex.: gemini-3.8-flash-tts);
 *  - PCM cru (`audio/l16; rate=24000; channels=1` ou `audio/pcm;rate=24000`), que precisa de cabeçalho.
 * Aqui normalizamos tudo para um único WAV PCM16 com cabeçalho correto.
 */

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface ParsedWav {
  format: PcmFormat & { audioFormat: number };
  /** Amostras (sem o cabeçalho). */
  data: Buffer;
}

export interface AudioMimeInfo extends PcmFormat {
  kind: 'wav' | 'pcm' | 'other';
}

/** Formato padrão da voz do Gemini (TTS e Live): PCM16 mono 24 kHz. */
export const GEMINI_OUTPUT_FORMAT: Readonly<PcmFormat> = Object.freeze({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 });

const WAV_HEADER_BYTES = 44;
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Embrulha amostras PCM (little-endian) num arquivo WAV com cabeçalho RIFF de 44 bytes. */
export function pcmToWav(pcm: Uint8Array, format: Partial<PcmFormat> = {}): Buffer {
  const sampleRate = positiveInt(format.sampleRate, GEMINI_OUTPUT_FORMAT.sampleRate);
  const channels = positiveInt(format.channels, GEMINI_OUTPUT_FORMAT.channels);
  const bitsPerSample = positiveInt(format.bitsPerSample, GEMINI_OUTPUT_FORMAT.bitsPerSample);
  const blockAlign = channels * Math.ceil(bitsPerSample / 8);
  // Descarta bytes que não completam um quadro (um byte solto deixaria o arquivo desalinhado).
  const dataLength = pcm.byteLength - (pcm.byteLength % blockAlign);

  const out = Buffer.alloc(WAV_HEADER_BYTES + dataLength);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataLength, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16); // tamanho do bloco fmt para PCM
  out.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(bitsPerSample, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataLength).copy(out, WAV_HEADER_BYTES);
  return out;
}

/** true quando o buffer começa com a assinatura RIFF/WAVE. */
export function isWav(buf: Uint8Array): boolean {
  if (buf.byteLength < 12) return false;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE';
}

/**
 * Lê um WAV percorrendo os blocos (tolera blocos extras como LIST e tamanhos de streaming
 * 0/0xFFFFFFFF no bloco data). Devolve null se não for um WAV utilizável.
 */
export function parseWav(buf: Uint8Array): ParsedWav | null {
  if (!isWav(buf)) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12;
  let format: ParsedWav['format'] | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || bodyStart + 16 > b.length) return null;
      let audioFormat = b.readUInt16LE(bodyStart);
      const channels = b.readUInt16LE(bodyStart + 2);
      const sampleRate = b.readUInt32LE(bodyStart + 4);
      const bitsPerSample = b.readUInt16LE(bodyStart + 14);
      // WAVE_FORMAT_EXTENSIBLE: o subformato real fica nos 2 primeiros bytes do GUID.
      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && size >= 26 && bodyStart + 26 <= b.length) {
        audioFormat = b.readUInt16LE(bodyStart + 24);
      }
      if (!channels || !sampleRate || !bitsPerSample) return null;
      format = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      const available = b.length - bodyStart;
      const length = size === 0 || size === 0xffffffff || size > available ? available : size;
      data = b.subarray(bodyStart, bodyStart + length);
      break;
    }
    if (size === 0xffffffff) break;
    offset = bodyStart + size + (size & 1); // blocos são alinhados em 2 bytes
  }
  if (!format || !data) return null;
  return { format, data };
}

/**
 * Interpreta o mimeType de áudio do Gemini.
 * Ex.: "audio/wav", "audio/L16;codec=pcm;rate=24000", "audio/pcm;rate=24000;channels=1".
 * Observação: apesar do nome "L16" (big-endian pela RFC 3551), o Gemini entrega little-endian.
 */
export function parseAudioMimeType(mimeType: string | null | undefined): AudioMimeInfo {
  const mime = (mimeType ?? '').toLowerCase().replace(/\s+/g, '');
  const [type = '', ...params] = mime.split(';');
  const param = (name: string): number | undefined => {
    const entry = params.find((p) => p.startsWith(`${name}=`));
    const value = entry ? Number.parseInt(entry.slice(name.length + 1), 10) : Number.NaN;
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  let kind: AudioMimeInfo['kind'] = 'other';
  let bitsPerSample: number = GEMINI_OUTPUT_FORMAT.bitsPerSample;
  if (/^audio\/(?:x-)?wave?$/.test(type) || type === 'audio/vnd.wave') kind = 'wav';
  else if (type === 'audio/l16' || type === 'audio/pcm' || type === 'audio/raw' || type === 'audio/x-raw') kind = 'pcm';
  else if (type === 'audio/l8') {
    kind = 'pcm';
    bitsPerSample = 8;
  }
  return {
    kind,
    sampleRate: param('rate') ?? GEMINI_OUTPUT_FORMAT.sampleRate,
    channels: param('channels') ?? GEMINI_OUTPUT_FORMAT.channels,
    bitsPerSample,
  };
}

const sameFormat = (a: PcmFormat, b: PcmFormat) =>
  a.sampleRate === b.sampleRate && a.channels === b.channels && a.bitsPerSample === b.bitsPerSample;

/**
 * Junta as partes de áudio de uma resposta do Gemini (base64 ou bytes) num único WAV.
 * Aceita WAV completo ou PCM cru; partes num formato diferente da primeira são ignoradas.
 * Devolve null quando nenhuma parte tem áudio utilizável.
 */
export function audioPartsToWav(parts: ReadonlyArray<{ mimeType?: string | null; data: string | Uint8Array }>): Buffer | null {
  let format: PcmFormat | null = null;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = typeof part.data === 'string' ? Buffer.from(part.data, 'base64') : Buffer.from(part.data);
    if (bytes.length === 0) continue;
    const mime = parseAudioMimeType(part.mimeType);
    let pcm: Buffer;
    let partFormat: PcmFormat;
    if (mime.kind === 'wav' || isWav(bytes)) {
      const parsed = parseWav(bytes);
      if (!parsed || parsed.format.audioFormat !== WAVE_FORMAT_PCM) continue;
      pcm = parsed.data;
      partFormat = parsed.format;
    } else if (mime.kind === 'pcm') {
      pcm = bytes;
      partFormat = mime;
    } else {
      continue;
    }
    if (!format) format = { sampleRate: partFormat.sampleRate, channels: partFormat.channels, bitsPerSample: partFormat.bitsPerSample };
    else if (!sameFormat(format, partFormat)) continue;
    chunks.push(pcm);
  }
  if (!format || chunks.length === 0) return null;
  const pcm = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  if (pcm.length === 0) return null;
  return pcmToWav(pcm, format);
}

/** Duração em segundos de um trecho PCM no formato dado. */
export function pcmDurationSeconds(byteLength: number, format: PcmFormat = GEMINI_OUTPUT_FORMAT): number {
  const bytesPerSecond = format.sampleRate * format.channels * Math.ceil(format.bitsPerSample / 8);
  return bytesPerSecond > 0 ? byteLength / bytesPerSecond : 0;
}
