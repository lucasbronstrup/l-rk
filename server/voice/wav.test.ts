import { describe, expect, it } from 'vitest';
import { audioPartsToWav, isWav, parseAudioMimeType, parseWav, pcmDurationSeconds, pcmToWav } from './wav.js';

/** PCM16 com amostras sequenciais (fácil de conferir byte a byte). */
function samplePcm(samples: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE((i * 37) % 30000, i * 2);
  return buf;
}

describe('pcmToWav', () => {
  it('escreve um cabeçalho RIFF/WAVE de 44 bytes com tamanhos e taxa corretos', () => {
    const pcm = samplePcm(2400); // 0,1 s a 24 kHz
    const wav = pcmToWav(pcm, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(48_000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it('usa 24 kHz mono 16 bits por padrão e respeita outras taxas', () => {
    expect(pcmToWav(samplePcm(10)).readUInt32LE(24)).toBe(24_000);
    const stereo = pcmToWav(samplePcm(16), { sampleRate: 16_000, channels: 2 });
    expect(stereo.readUInt16LE(22)).toBe(2);
    expect(stereo.readUInt32LE(24)).toBe(16_000);
    expect(stereo.readUInt32LE(28)).toBe(64_000);
    expect(stereo.readUInt16LE(32)).toBe(4);
  });

  it('descarta o byte solto que não completa uma amostra', () => {
    const odd = Buffer.concat([samplePcm(5), Buffer.from([7])]);
    const wav = pcmToWav(odd);
    expect(wav.readUInt32LE(40)).toBe(10);
    expect(wav.length).toBe(54);
  });

  it('respeita subarrays (byteOffset) sem vazar bytes vizinhos', () => {
    const big = samplePcm(100);
    const slice = big.subarray(20, 60);
    const wav = pcmToWav(slice);
    expect(wav.subarray(44).equals(slice)).toBe(true);
  });
});

describe('parseWav', () => {
  it('lê de volta o que pcmToWav escreve', () => {
    const pcm = samplePcm(500);
    const parsed = parseWav(pcmToWav(pcm, { sampleRate: 22_050 }));
    expect(parsed).not.toBeNull();
    expect(parsed!.format).toEqual({ audioFormat: 1, sampleRate: 22_050, channels: 1, bitsPerSample: 16 });
    expect(parsed!.data.equals(pcm)).toBe(true);
  });

  it('tolera blocos extras (LIST) e tamanho de streaming no bloco data', () => {
    const pcm = samplePcm(64);
    const base = pcmToWav(pcm);
    const list = Buffer.alloc(8 + 5 + 1); // bloco ímpar com byte de alinhamento
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(5, 4);
    const header = base.subarray(0, 36);
    const dataChunk = Buffer.from(base.subarray(36));
    dataChunk.writeUInt32LE(0xffffffff, 4);
    const wav = Buffer.concat([header, list, dataChunk]);
    const parsed = parseWav(wav);
    expect(parsed?.data.equals(pcm)).toBe(true);
  });

  it('recusa o que não é WAV', () => {
    expect(isWav(Buffer.from('ID3 não é wav'))).toBe(false);
    expect(parseWav(Buffer.from('RIFF0000WAVE'))).toBeNull();
    expect(parseWav(samplePcm(100))).toBeNull();
  });
});

describe('parseAudioMimeType', () => {
  it('entende os formatos devolvidos pelo Gemini', () => {
    expect(parseAudioMimeType('audio/wav')).toMatchObject({ kind: 'wav' });
    expect(parseAudioMimeType('audio/L16;codec=pcm;rate=24000')).toEqual({ kind: 'pcm', sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    expect(parseAudioMimeType('audio/l16; rate=16000; channels=2')).toEqual({ kind: 'pcm', sampleRate: 16_000, channels: 2, bitsPerSample: 16 });
    expect(parseAudioMimeType('audio/pcm;rate=24000')).toMatchObject({ kind: 'pcm', sampleRate: 24_000 });
    expect(parseAudioMimeType('audio/mpeg')).toMatchObject({ kind: 'other' });
    expect(parseAudioMimeType(undefined)).toMatchObject({ kind: 'other', sampleRate: 24_000 });
  });
});

describe('audioPartsToWav', () => {
  it('embrulha PCM cru (audio/l16) com a taxa do mimeType', () => {
    const pcm = samplePcm(1200);
    const wav = audioPartsToWav([{ mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') }]);
    expect(wav).not.toBeNull();
    expect(wav!.readUInt32LE(24)).toBe(24_000);
    expect(wav!.subarray(44).equals(pcm)).toBe(true);
  });

  it('não embrulha de novo um WAV pronto (audio/wav) e junta várias partes', () => {
    const a = samplePcm(300);
    const b = samplePcm(200);
    const wav = audioPartsToWav([
      { mimeType: 'audio/wav', data: pcmToWav(a).toString('base64') },
      { mimeType: 'audio/pcm;rate=24000', data: b },
    ]);
    expect(wav).not.toBeNull();
    const parsed = parseWav(wav!);
    expect(parsed!.data.equals(Buffer.concat([a, b]))).toBe(true);
    // Um único cabeçalho RIFF no arquivo final.
    expect(wav!.indexOf('RIFF', 4)).toBe(-1);
  });

  it('ignora partes sem áudio utilizável ou em formato diferente', () => {
    const pcm = samplePcm(100);
    const wav = audioPartsToWav([
      { mimeType: 'audio/mpeg', data: Buffer.from('mp3') },
      { mimeType: 'audio/pcm;rate=24000', data: pcm },
      { mimeType: 'audio/pcm;rate=16000', data: samplePcm(50) },
      { mimeType: 'audio/pcm;rate=24000', data: '' },
    ]);
    expect(parseWav(wav!)!.data.equals(pcm)).toBe(true);
    expect(audioPartsToWav([{ mimeType: 'audio/mpeg', data: Buffer.from('mp3') }])).toBeNull();
    expect(audioPartsToWav([])).toBeNull();
  });
});

describe('pcmDurationSeconds', () => {
  it('calcula a duração do PCM16 mono 24 kHz', () => {
    expect(pcmDurationSeconds(48_000)).toBe(1);
    expect(pcmDurationSeconds(32_000, { sampleRate: 16_000, channels: 1, bitsPerSample: 16 })).toBe(1);
  });
});
