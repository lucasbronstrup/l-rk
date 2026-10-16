import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  process.env.LARK_MOCK = '1';
});

import { config } from '../config.js';
import { voiceRoutes } from '../routes/voice.js';

const postTts = (body: unknown, raw = false) =>
  voiceRoutes.request('/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? String(body) : JSON.stringify(body),
  });

describe('rotas de voz (modo demonstração)', () => {
  it('está em modo demonstração', () => {
    expect(config.mock).toBe(true);
  });

  it('POST /tts responde 204 sem corpo e informa o motivo', async () => {
    const res = await postTts({ text: 'Olá, Lärk. Bora?' });
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Lark-TTS-Reason')).toBe('mock');
    expect(await res.text()).toBe('');
  });

  it('POST /tts aceita voz e estilo opcionais', async () => {
    const res = await postTts({ text: 'Teste.', voiceName: 'Orus', style: 'calmo' });
    expect(res.status).toBe(204);
  });

  it('POST /tts recusa corpo inválido com mensagem em português', async () => {
    const notJson = await postTts('{texto', true);
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: string }).error).toMatch(/JSON/);

    const empty = await postTts({ text: '' });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe('O texto para falar está vazio.');

    const wrongType = await postTts({ text: 42 });
    expect(wrongType.status).toBe(400);

    const huge = await postTts({ text: 'a'.repeat(20_001) });
    expect(huge.status).toBe(400);
  });

  it('GET /voices lista as vozes com descrição em português', async () => {
    const res = await voiceRoutes.request('/voices');
    expect(res.status).toBe(200);
    const voices = (await res.json()) as { name: string; description: string }[];
    expect(voices.length).toBeGreaterThanOrEqual(29);
    expect(voices[0]).toEqual({ name: 'Charon', description: expect.stringMatching(/grave/) });
    expect(voices.every((v) => v.name && v.description)).toBe(true);
  });
});
