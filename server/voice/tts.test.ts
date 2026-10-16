import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

const h = vi.hoisted(() => ({
  hasKey: true,
  generate: vi.fn(),
}));

vi.mock('../llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/gemini.js')>();
  return {
    ...actual,
    getClient: () => (h.hasKey ? ({} as object) : null),
    generateWithFallback: h.generate,
  };
});

import { config } from '../config.js';
import { updateSettings } from '../memory/settings.js';
import { pcmToWav, parseWav } from './wav.js';
import {
  MAX_TTS_CHARS,
  buildTtsPrompt,
  getTtsStatus,
  normalizeForSpeech,
  resetTtsState,
  resolveVoiceDirection,
  synthesizeSpeech,
  synthesizeSpeechDetailed,
} from './tts.js';
import { DEFAULT_VOICE, GEMINI_VOICES, findVoice, listVoices, resolveVoiceName } from './voices.js';

const originalMock = config.mock;

function pcm(samples: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 1000, i * 2);
  return buf;
}

/** Resposta mínima do generateContent com partes de áudio. */
function audioResponse(parts: { mimeType: string; data: Buffer }[]) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: parts.map((p) => ({ inlineData: { mimeType: p.mimeType, data: p.data.toString('base64') } })) },
        finishReason: 'STOP',
      },
    ],
  };
}

type GenerateArgs = [string, { contents: { parts: { text: string }[] }[]; config: Record<string, any> }, Record<string, unknown>];

beforeEach(() => {
  config.mock = false;
  h.hasKey = true;
  h.generate.mockReset();
  resetTtsState();
});

afterAll(() => {
  config.mock = originalMock;
});

describe('normalizeForSpeech', () => {
  it('limpa markdown, código e URLs, mantendo o texto natural', () => {
    const input = [
      '# Plano de hoje',
      '',
      'Veja **isto** com _calma_ e leia [o guia](https://exemplo.com/guia).',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '- Primeiro passo',
      '- Segundo passo.',
      '',
      'Mais em https://exemplo.com/docs?x=1 e use `npm test`. 🚀',
    ].join('\n');
    const out = normalizeForSpeech(input);
    expect(out).toContain('Plano de hoje.');
    expect(out).toContain('Veja isto com calma e leia o guia.');
    expect(out).toContain('Primeiro passo;');
    expect(out).toContain('Segundo passo.');
    expect(out).toContain('use npm test.');
    expect(out).not.toMatch(/https?:|```|const x|\*\*|#|🚀|\[|\]/);
  });

  it('transforma tabelas em frases e remove HTML', () => {
    const out = normalizeForSpeech('| Nome | Idade |\n|---|---|\n| Ana | 30 |\n\n<b>fim</b>');
    expect(out).toContain('Nome, Idade.');
    expect(out).toContain('Ana, 30.');
    expect(out).toContain('fim');
    expect(out).not.toContain('<b>');
  });

  it('preserva reticências e pontuação expressiva', () => {
    expect(normalizeForSpeech('Então... pensei melhor! E você?')).toBe('Então... pensei melhor! E você?');
  });

  it('corta textos longos no fim de uma frase, respeitando o limite', () => {
    const sentence = 'Esta é uma frase completa sobre o futuro. ';
    const long = sentence.repeat(200);
    const out = normalizeForSpeech(long);
    expect(out.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
    expect(out.endsWith('futuro.')).toBe(true);
    const tiny = normalizeForSpeech('palavra '.repeat(50), 30);
    expect(tiny.length).toBeLessThanOrEqual(31);
    expect(tiny.endsWith('…')).toBe(true);
  });

  it('devolve vazio para entradas sem texto', () => {
    expect(normalizeForSpeech('')).toBe('');
    expect(normalizeForSpeech('```\ncódigo\n```')).toBe('');
  });
});

describe('prompt e direção de estilo', () => {
  it('separa a direção do texto a ser lido', () => {
    const prompt = buildTtsPrompt('Bom dia, Lucas.', 'voz grave e calorosa');
    expect(prompt).toContain('português do Brasil');
    expect(prompt).toContain('Estilo de voz: voz grave e calorosa');
    expect(prompt.trimEnd().endsWith('TEXTO:\nBom dia, Lucas.')).toBe(true);
  });

  it('usa o estilo pedido ou, na falta dele, a direção de voz da persona', () => {
    const settings = updateSettings({ voiceStyle: 'narrador de documentário' });
    expect(resolveVoiceDirection(settings, '  sussurrando  ')).toBe('sussurrando');
    const direction = resolveVoiceDirection(settings);
    expect(direction).toContain('narrador de documentário');
    expect(direction).toContain('português do Brasil');
  });
});

describe('synthesizeSpeech', () => {
  it('embrulha o PCM cru (audio/l16) num WAV de 24 kHz', async () => {
    const audio = pcm(2400);
    h.generate.mockResolvedValue({ response: audioResponse([{ mimeType: 'audio/L16;codec=pcm;rate=24000', data: audio }]), model: 'gemini-3.1-flash-tts-preview' });

    const result = await synthesizeSpeech('Olá, mundo. Tudo começa com uma pergunta.');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('gemini-3.1-flash-tts-preview');
    const parsed = parseWav(result!.wav);
    expect(parsed!.format.sampleRate).toBe(24_000);
    expect(parsed!.data.equals(audio)).toBe(true);

    const [role, params, opts] = h.generate.mock.calls[0] as GenerateArgs;
    expect(role).toBe('tts');
    expect(params.config.responseModalities).toEqual(['AUDIO']);
    expect(params.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Charon');
    expect(params.contents[0].parts[0].text).toContain('TEXTO:\nOlá, mundo. Tudo começa com uma pergunta.');
    expect(opts).toMatchObject({ maxAttempts: 3 });
  });

  it('aceita WAV pronto (audio/wav) sem duplicar o cabeçalho', async () => {
    const audio = pcm(1000);
    h.generate.mockResolvedValue({ response: audioResponse([{ mimeType: 'audio/wav', data: pcmToWav(audio) }]), model: 'gemini-3.8-flash-tts' });
    const result = await synthesizeSpeech('Teste de voz.');
    expect(result!.wav.length).toBe(44 + audio.length);
    expect(parseWav(result!.wav)!.data.equals(audio)).toBe(true);
  });

  it('usa a voz e o estilo pedidos, e troca vozes desconhecidas pela padrão', async () => {
    h.generate.mockResolvedValue({ response: audioResponse([{ mimeType: 'audio/pcm;rate=24000', data: pcm(10) }]), model: 'm' });
    await synthesizeSpeech('Primeira frase.', { voiceName: 'puck', style: 'animado' });
    await synthesizeSpeech('Segunda frase.', { voiceName: 'VozInexistente' });
    const first = h.generate.mock.calls[0] as GenerateArgs;
    const second = h.generate.mock.calls[1] as GenerateArgs;
    expect(first[1].config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
    expect(first[1].contents[0].parts[0].text).toContain('Estilo de voz: animado');
    expect(second[1].config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(DEFAULT_VOICE);
  });

  it('guarda em cache por texto + voz + estilo e deduplica pedidos simultâneos', async () => {
    h.generate.mockResolvedValue({ response: audioResponse([{ mimeType: 'audio/pcm;rate=24000', data: pcm(500) }]), model: 'm' });

    const [a, b] = await Promise.all([synthesizeSpeechDetailed('Frase repetida.'), synthesizeSpeechDetailed('Frase repetida.')]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(a.ok && b.ok).toBe(true);

    const again = await synthesizeSpeechDetailed('Frase   repetida.');
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ ok: true, cached: true });

    await synthesizeSpeechDetailed('Frase repetida.', { voiceName: 'Kore' });
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(getTtsStatus().cache.entries).toBe(2);
  });

  it('limita o cache a 50 itens (LRU)', async () => {
    h.generate.mockResolvedValue({ response: audioResponse([{ mimeType: 'audio/pcm;rate=24000', data: pcm(10) }]), model: 'm' });
    for (let i = 0; i < 55; i++) await synthesizeSpeech(`Frase número ${i}.`);
    expect(getTtsStatus().cache.entries).toBe(50);
    h.generate.mockClear();
    await synthesizeSpeech('Frase número 54.'); // recente: no cache
    expect(h.generate).not.toHaveBeenCalled();
    await synthesizeSpeech('Frase número 0.'); // mais antiga: foi descartada
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('devolve null em modo demonstração e sem chave, sem chamar o Gemini', async () => {
    config.mock = true;
    expect(await synthesizeSpeechDetailed('Olá.')).toMatchObject({ ok: false, reason: 'mock' });
    config.mock = false;
    h.hasKey = false;
    expect(await synthesizeSpeechDetailed('Olá.')).toMatchObject({ ok: false, reason: 'no_api_key' });
    expect(await synthesizeSpeech('Olá.')).toBeNull();
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('em cota esgotada devolve null, registra o motivo e pausa novas tentativas', async () => {
    const quota = Object.assign(
      new Error('{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}'),
      { status: 429 },
    );
    h.generate.mockRejectedValue(quota);
    expect(await synthesizeSpeechDetailed('Fale comigo.')).toMatchObject({ ok: false, reason: 'quota' });
    const status = getTtsStatus();
    expect(status.lastFailure?.reason).toBe('quota');
    expect(status.quotaCooldownUntil).not.toBeNull();
    expect(status.available).toBe(false);

    expect(await synthesizeSpeech('Outra frase.')).toBeNull();
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('trata resposta sem áudio e falhas inesperadas como indisponibilidade', async () => {
    h.generate.mockResolvedValueOnce({ response: { candidates: [{ content: { parts: [{ text: 'oi' }] }, finishReason: 'OTHER' }] }, model: 'm' });
    expect(await synthesizeSpeechDetailed('Sem áudio.')).toMatchObject({ ok: false, reason: 'provider' });
    h.generate.mockRejectedValueOnce(new Error('falha estranha'));
    expect(await synthesizeSpeechDetailed('Erro.')).toMatchObject({ ok: false, reason: 'internal' });
  });

  it('não chama o Gemini para texto sem conteúdo legível', async () => {
    expect(await synthesizeSpeechDetailed('```\nconst x = 1;\n```')).toMatchObject({ ok: false, reason: 'empty' });
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe('vozes', () => {
  it('tem as vozes pré-definidas do Gemini com descrição em português', async () => {
    expect(GEMINI_VOICES.length).toBeGreaterThanOrEqual(29);
    expect(new Set(GEMINI_VOICES.map((v) => v.name)).size).toBe(GEMINI_VOICES.length);
    expect(findVoice('charon')?.description).toMatch(/grave/);
    for (const name of ['Orus', 'Puck', 'Kore', 'Fenrir', 'Aoede', 'Zephyr', 'Enceladus', 'Zubenelgenubi']) {
      expect(findVoice(name)?.name).toBe(name);
    }
  });

  it('normaliza nomes e cai para a voz padrão', () => {
    expect(resolveVoiceName('  orus ')).toBe('Orus');
    expect(resolveVoiceName('')).toBe(DEFAULT_VOICE);
    expect(resolveVoiceName('Inexistente')).toBe(DEFAULT_VOICE);
    expect(resolveVoiceName(undefined)).toBe(DEFAULT_VOICE);
  });

  it('lista as vozes fixas quando o catálogo remoto não está disponível', async () => {
    h.hasKey = false;
    const voices = await listVoices();
    expect(voices.map((v) => v.name)).toEqual(GEMINI_VOICES.map((v) => v.name));
  });
});
