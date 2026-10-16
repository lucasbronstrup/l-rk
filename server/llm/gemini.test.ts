import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  delete process.env.LARK_MOCK;
  for (const role of ['CHAT', 'FAST', 'TTS', 'LIVE', 'EMBEDDING']) delete process.env[`LARK_MODEL_${role}`];
  return {
    apiKey: 'chave-1',
    overrides: { chat: '', fast: '', tts: '', live: '', embedding: '' } as Record<string, string>,
    models: [] as { name: string; displayName?: string; supportedActions?: string[] }[],
    listCalls: 0,
    listError: null as unknown,
    constructed: [] as string[],
    generate: null as null | ((params: { model: string }) => Promise<unknown>),
  };
});

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    models: { list: () => Promise<AsyncIterable<unknown>>; generateContent: (p: { model: string }) => Promise<unknown> };
    constructor(opts: { apiKey: string }) {
      fake.constructed.push(opts.apiKey);
      this.models = {
        list: async () => {
          fake.listCalls++;
          if (fake.listError) throw fake.listError;
          const items = [...fake.models];
          return {
            async *[Symbol.asyncIterator]() {
              yield* items;
            },
          };
        },
        generateContent: (p) => {
          if (!fake.generate) throw new Error('generate não configurado');
          return fake.generate(p);
        },
      };
    }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

vi.mock('../memory/settings.js', () => ({
  getApiKey: () => fake.apiKey,
  getSettings: () => ({ models: { ...fake.overrides } }),
}));

import { ApiError } from '@google/genai';
import {
  GeminiError,
  classifyGeminiError,
  generateText,
  getActiveModels,
  getClient,
  getModelFallbacks,
  inferModelRoles,
  isRetryableModelError,
  listAvailableModels,
  rankModelsForRole,
  resetModelCooldowns,
  resolveModel,
} from './gemini.js';

const TEXT = ['generateContent', 'countTokens', 'createCachedContent', 'batchGenerateContent'];

function apiError(status: number, body: Record<string, unknown>): ApiError {
  return new ApiError({ message: JSON.stringify({ error: { code: status, ...body } }), status });
}

let keySeq = 0;
/** Usa uma chave nova (o cliente e os caches são recriados). */
function freshKey(): void {
  fake.apiKey = `chave-teste-${++keySeq}`;
}

beforeEach(() => {
  freshKey();
  fake.overrides = { chat: '', fast: '', tts: '', live: '', embedding: '' };
  fake.listError = null;
  fake.listCalls = 0;
  fake.generate = null;
  fake.models = [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedActions: TEXT },
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedActions: TEXT },
    { name: 'models/gemini-2.5-flash-lite', supportedActions: TEXT },
    { name: 'models/gemini-3.1-pro-preview', supportedActions: TEXT },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedActions: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.5-pro-preview-tts', supportedActions: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedActions: ['embedContent', 'countTextTokens'] },
    { name: 'models/gemini-2.5-flash-native-audio-latest', supportedActions: ['bidiGenerateContent'] },
    { name: 'models/imagen-4.0-generate-001', supportedActions: ['predict'] },
    { name: 'models/gemma-3-27b-it', supportedActions: TEXT },
    { name: 'models/gemini-2.5-flash-image', supportedActions: TEXT },
  ];
  resetModelCooldowns();
});

describe('inferModelRoles', () => {
  it('reconhece as funções pelo nome e pelas ações', () => {
    expect(inferModelRoles('gemini-2.5-flash', TEXT)).toEqual(['chat', 'fast']);
    expect(inferModelRoles('gemini-2.5-flash-preview-tts', ['generateContent'])).toEqual(['tts']);
    expect(inferModelRoles('gemini-embedding-001', ['embedContent'])).toEqual(['embedding']);
    expect(inferModelRoles('gemini-2.5-flash-native-audio-latest', ['bidiGenerateContent'])).toEqual(['live']);
    expect(inferModelRoles('gemini-3.8-live', ['bidiGenerateContent'])).toEqual(['live']);
    expect(inferModelRoles('gemini-embedding-2', ['embedContent'])).toEqual(['embedding']);
    expect(inferModelRoles('imagen-4.0-generate-001', ['predict'])).toEqual([]);
    expect(inferModelRoles('gemma-3-27b-it', TEXT)).toEqual([]);
    expect(inferModelRoles('gemini-2.5-flash-image', TEXT)).toEqual([]);
  });

  it('não trata modelos de transcrição, tradução, robótica ou música como conversa por voz', () => {
    const bidi = ['bidiGenerateContent'];
    expect(inferModelRoles('gemini-3.5-transcribe-live', bidi)).not.toContain('live');
    expect(inferModelRoles('gemini-3.5-live-translate-preview', bidi)).not.toContain('live');
    expect(inferModelRoles('gemini-robotics-er-2-streaming-preview', bidi)).not.toContain('live');
    expect(inferModelRoles('lyria-realtime-exp', bidi)).not.toContain('live');
    expect(inferModelRoles('gemini-3.5-transcribe', TEXT)).toEqual([]);
  });
});

describe('rankModelsForRole', () => {
  it('segue a lista de preferência', () => {
    expect(rankModelsForRole('chat', ['gemini-2.5-flash', 'gemini-3.5-flash'])[0]).toBe('gemini-3.5-flash');
    expect(rankModelsForRole('fast', ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest'])[0]).toBe('gemini-flash-lite-latest');
  });

  it('usa a heurística para modelos novos: maior versão, flash, sem pro', () => {
    const ids = ['gemini-4.0-pro', 'gemini-4.0-flash', 'gemini-4.0-flash-lite', 'gemini-3.9-flash', 'gemini-4.0-flash-exp'];
    expect(rankModelsForRole('chat', ids)[0]).toBe('gemini-4.0-flash');
    expect(rankModelsForRole('fast', ids)[0]).toBe('gemini-4.0-flash-lite');
    expect(rankModelsForRole('chat', ids).at(-1)).toBe('gemini-4.0-pro');
  });

  it('nunca escolhe TTS "pro" quando há alternativa', () => {
    expect(rankModelsForRole('tts', ['gemini-9.0-pro-tts', 'gemini-4.0-flash-tts'])).toEqual(['gemini-4.0-flash-tts']);
  });
});

describe('catálogo e resolução', () => {
  it('lista modelos sem o prefixo "models/", com cache de 1 h', async () => {
    const list = await listAvailableModels();
    const ids = list.map((m) => m.id);
    expect(ids).toContain('gemini-2.5-flash');
    expect(ids).not.toContain('imagen-4.0-generate-001');
    expect(ids).not.toContain('gemma-3-27b-it');
    expect(list.find((m) => m.id === 'gemini-3.5-flash')?.displayName).toBe('Gemini 3.5 Flash');
    await listAvailableModels();
    expect(fake.listCalls).toBe(1);
    await listAvailableModels(true);
    expect(fake.listCalls).toBe(2);
  });

  it('resolve o melhor modelo disponível por função', async () => {
    expect(await resolveModel('chat')).toBe('gemini-3.5-flash');
    expect(await resolveModel('fast')).toBe('gemini-2.5-flash-lite');
    expect(await resolveModel('tts')).toBe('gemini-2.5-flash-preview-tts');
    expect(await resolveModel('embedding')).toBe('gemini-embedding-001');
    expect(await resolveModel('live')).toBe('gemini-2.5-flash-native-audio-latest');
  });

  it('respeita a escolha do usuário nas configurações', async () => {
    fake.overrides.chat = 'models/gemini-2.5-flash';
    expect(await resolveModel('chat')).toBe('gemini-2.5-flash');
    expect(getModelFallbacks('chat')[0]).toBe('gemini-2.5-flash');
  });

  it('cai para a lista de preferência quando a listagem falha', async () => {
    fake.listError = apiError(403, { message: 'API key not valid', status: 'PERMISSION_DENIED' });
    expect(await resolveModel('chat')).toBe('gemini-3.8-flash');
    expect(getModelFallbacks('chat')).toContain('gemini-2.5-flash');
  });

  it('recria o cliente quando a chave muda e devolve null sem chave', () => {
    const a = getClient();
    expect(getClient()).toBe(a);
    freshKey();
    expect(getClient()).not.toBe(a);
    fake.apiKey = '';
    expect(getClient()).toBeNull();
  });

  it('getActiveModels fica vazio sem chave', async () => {
    fake.apiKey = '';
    expect(await getActiveModels()).toEqual({});
  });

  it('getActiveModels resolve todas as funções', async () => {
    const active = await getActiveModels();
    expect(active).toMatchObject({ chat: 'gemini-3.5-flash', tts: 'gemini-2.5-flash-preview-tts' });
  });
});

describe('generateText', () => {
  it('troca de modelo quando a cota estoura e evita o modelo esgotado depois', async () => {
    const calls: string[] = [];
    fake.generate = async ({ model }) => {
      calls.push(model);
      if (model === 'gemini-3.5-flash') {
        throw apiError(429, {
          message: 'You exceeded your current quota',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23s' }],
        });
      }
      return { text: `resposta de ${model}` };
    };
    await expect(generateText({ prompt: 'oi', system: 'seja breve' })).resolves.toBe('resposta de gemini-2.5-flash');
    expect(calls).toEqual(['gemini-3.5-flash', 'gemini-2.5-flash']);
    expect(getModelFallbacks('chat')[0]).toBe('gemini-2.5-flash');
    expect(getModelFallbacks('chat')).toContain('gemini-3.5-flash'); // continua como última opção
  });

  it('envia system instruction e JSON quando pedido', async () => {
    let received: Record<string, unknown> = {};
    fake.generate = async (params) => {
      received = params as unknown as Record<string, unknown>;
      return { text: '{"ok":true}' };
    };
    await generateText({ prompt: 'extraia', role: 'fast', json: true, temperature: 0.1, system: 'sistema' });
    expect(received.model).toBe('gemini-2.5-flash-lite');
    expect(received.config).toMatchObject({ systemInstruction: 'sistema', responseMimeType: 'application/json', temperature: 0.1 });
  });

  it('não insiste em erros que outro modelo não resolve', async () => {
    let count = 0;
    fake.generate = async () => {
      count++;
      throw apiError(400, { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' });
    };
    const error = await generateText({ prompt: 'oi' }).catch((e: unknown) => e);
    expect(count).toBe(1);
    expect(classifyGeminiError(error).code).toBe('no_api_key');
  });

  it('exige chave', async () => {
    fake.apiKey = '';
    await expect(generateText({ prompt: 'oi' })).rejects.toBeInstanceOf(GeminiError);
  });
});

describe('classifyGeminiError', () => {
  it('traduz cota, chave inválida, modelo inexistente, sobrecarga e rede', () => {
    const quota = classifyGeminiError(apiError(429, { message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' }));
    expect(quota.code).toBe('quota');
    expect(quota.message).toMatch(/limite gratuito/);

    const daily = classifyGeminiError(
      apiError(429, {
        message: 'quota',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
      }),
    );
    expect(daily.message).toMatch(/limite diário/);

    expect(classifyGeminiError(apiError(400, { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' })).code).toBe(
      'no_api_key',
    );
    expect(classifyGeminiError(apiError(404, { message: 'models/x is not found', status: 'NOT_FOUND' })).message).toMatch(/não está disponível/);
    expect(classifyGeminiError(apiError(503, { message: 'The model is overloaded', status: 'UNAVAILABLE' })).message).toMatch(/sobrecarregados/);
    expect(classifyGeminiError(new TypeError('fetch failed')).message).toMatch(/internet/);
    expect(classifyGeminiError(new GeminiError('quota', 'x'))).toEqual({ code: 'quota', message: 'x' });
    expect(classifyGeminiError(new Error('boom')).code).toBe('internal');
  });

  it('identifica erros que justificam outro modelo', () => {
    expect(isRetryableModelError(apiError(429, { status: 'RESOURCE_EXHAUSTED' }))).toBe(true);
    expect(isRetryableModelError(apiError(404, { status: 'NOT_FOUND' }))).toBe(true);
    expect(isRetryableModelError(apiError(503, { status: 'UNAVAILABLE' }))).toBe(true);
    expect(isRetryableModelError(apiError(400, { message: 'Invalid JSON payload', status: 'INVALID_ARGUMENT' }))).toBe(false);
  });
});
