import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  delete process.env.LARK_MOCK;
  process.env.GEMINI_API_KEY = '';
  process.env.GOOGLE_API_KEY = '';
  type Script = (params: { model: string; contents: unknown; config: Record<string, unknown> }) => unknown;
  return {
    hasClient: true,
    models: ['fake-a', 'fake-b', 'fake-c'],
    scripts: [] as Script[],
    requests: [] as { model: string; contents: any[]; config: Record<string, any> }[],
  };
});

vi.mock('../llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/gemini.js')>();
  const client = {
    models: {
      generateContentStream: async (params: { model: string; contents: unknown; config: Record<string, unknown> }) => {
        const { abortSignal, ...config } = params.config;
        fake.requests.push({ model: params.model, contents: structuredClone(params.contents) as any[], config: structuredClone(config) });
        const script = fake.scripts.shift();
        if (!script) throw new Error('roteiro de teste esgotado');
        const result = script({ ...params, config: { ...config, abortSignal } });
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return {
    ...actual,
    getClient: () => (fake.hasClient ? client : null),
    resolveModel: async (role: string) => (role === 'chat' ? fake.models[0] : ''),
    getModelFallbacks: () => [...fake.models],
    generateText: async () => '{}',
  };
});

import { ApiError } from '@google/genai';
import { createConversation } from '../memory/conversations.js';
import { listMessages } from '../memory/messages.js';
import { listCommitments } from '../memory/commitments.js';
import { updateSettings } from '../memory/settings.js';
import { disposeMathEngine } from '../tools/utility.js';
import { AgentTurnError, runAgentTurn } from './loop.js';
import { cancelPostTurn } from './post-turn.js';
import type { ChatStreamEvent } from '../../shared/types.js';

updateSettings({ timezone: 'America/Sao_Paulo', userName: 'Lucas' });

afterAll(async () => {
  cancelPostTurn();
  await disposeMathEngine();
});

beforeEach(() => {
  fake.hasClient = true;
  fake.scripts = [];
  fake.requests = [];
});

type Part = Record<string, unknown>;
const chunk = (parts: Part[], finishReason?: string) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
});

/** Streaming simulado: entrega os pedaços em sequência (respeitando o cancelamento). */
function stream(chunks: ReturnType<typeof chunk>[], opts: { hangAfter?: number; failAfter?: { index: number; error: Error } } = {}) {
  return (params: { config: Record<string, unknown> }) => {
    const signal = params.config.abortSignal as AbortSignal | undefined;
    return (async function* () {
      for (let i = 0; i < chunks.length; i++) {
        if (opts.failAfter && opts.failAfter.index === i) throw opts.failAfter.error;
        if (opts.hangAfter !== undefined && i === opts.hangAfter) {
          await new Promise((_, reject) => {
            const fail = () => reject(new DOMException('abortado', 'AbortError'));
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
          });
        }
        await new Promise((r) => setTimeout(r, 1));
        yield chunks[i];
      }
    })();
  };
}

const apiError = (status: number, message: string) =>
  new ApiError({ message: JSON.stringify({ error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE' } }), status });

async function turn(conversationId: string, userText: string, signal?: AbortSignal) {
  const events: ChatStreamEvent[] = [];
  const promise = runAgentTurn({ conversationId, userText, onEvent: (e) => events.push(e), signal });
  return { events, promise };
}

describe('runAgentTurn com o Gemini', () => {
  it('pensa, chama ferramentas, devolve o resultado com a assinatura e responde', async () => {
    const conversation = createConversation();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    fake.scripts.push(
      stream([
        chunk([{ thought: true, text: 'O usuário fez uma promessa.' }]),
        chunk([{ text: 'Registrando ' }]),
        chunk([{ text: 'agora.' }]),
        chunk(
          [
            {
              functionCall: { id: 'fc-1', name: 'create_commitment', args: { description: 'Estudar cálculo', due_at: tomorrow } },
              thoughtSignature: 'assinatura-1',
            },
          ],
          'STOP',
        ),
      ]),
      stream([chunk([{ text: 'Pronto: promessa anotada.' }]), chunk([{ text: ' Bora?', thoughtSignature: 'assinatura-2' }], 'STOP')]),
    );

    const { events, promise } = await turn(conversation.id, 'Prometo estudar cálculo amanhã');
    const message = await promise;

    expect(events[0]).toMatchObject({ type: 'meta', model: 'fake-a' });
    expect(events).toContainEqual({ type: 'thought', text: 'O usuário fez uma promessa.' });
    const text = events
      .filter((e): e is Extract<ChatStreamEvent, { type: 'token' }> => e.type === 'token')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Registrando agora.\n\nPronto: promessa anotada. Bora?');
    expect(message.content).toBe(text);
    expect(message.thoughts).toBe('O usuário fez uma promessa.');
    expect(message.toolCalls).toHaveLength(1);
    expect(message.toolCalls?.[0]).toMatchObject({ id: 'fc-1', name: 'create_commitment', status: 'done' });
    expect(events.at(-1)).toEqual({ type: 'done', message });
    expect(listCommitments({ status: 'open' }).map((c) => c.description)).toContain('Estudar cálculo');

    // Primeira requisição: histórico, persona/contexto, ferramentas e pensamento visível.
    const first = fake.requests[0];
    expect(first.contents.at(-1)).toEqual({ role: 'user', parts: [{ text: 'Prometo estudar cálculo amanhã' }] });
    expect(first.config.systemInstruction).toContain('Lärk');
    expect(first.config.systemInstruction).toContain('PROMESSAS ABERTAS');
    expect(first.config.thinkingConfig).toEqual({ includeThoughts: true });
    expect(first.config.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toContain('create_commitment');
    expect(first.config.toolConfig).toBeUndefined();

    // Segunda requisição: fala do modelo com a assinatura preservada + resposta da função.
    const second = fake.requests[1];
    const modelTurn = second.contents.at(-2);
    expect(modelTurn.role).toBe('model');
    expect(modelTurn.parts).toContainEqual({ text: 'Registrando agora.' });
    expect(modelTurn.parts).toContainEqual(
      expect.objectContaining({ functionCall: expect.objectContaining({ id: 'fc-1' }), thoughtSignature: 'assinatura-1' }),
    );
    expect(modelTurn.parts.some((p: Part) => p.thought)).toBe(false);
    const responseTurn = second.contents.at(-1);
    expect(responseTurn.role).toBe('user');
    expect(responseTurn.parts[0].functionResponse).toMatchObject({ id: 'fc-1', name: 'create_commitment', response: { ok: true } });

    const saved = listMessages(conversation.id);
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('executa chamadas seguras em paralelo e devolve as respostas na ordem', async () => {
    const conversation = createConversation();
    fake.scripts.push(
      stream([
        chunk(
          [
            { functionCall: { name: 'list_commitments', args: {} }, thoughtSignature: 's1' },
            { functionCall: { name: 'list_reminders', args: {} } },
          ],
          'STOP',
        ),
      ]),
      stream([chunk([{ text: 'Tudo em ordem.' }], 'STOP')]),
    );
    const { promise } = await turn(conversation.id, 'Como estão minhas pendências?');
    const message = await promise;
    expect(message.toolCalls?.map((c) => c.name)).toEqual(['list_commitments', 'list_reminders']);
    const responses = fake.requests[1].contents.at(-1).parts.map((p: Part) => (p.functionResponse as { name: string }).name);
    expect(responses).toEqual(['list_commitments', 'list_reminders']);
  });

  it('troca de modelo antes do primeiro token quando há sobrecarga', async () => {
    const conversation = createConversation();
    fake.scripts.push(
      () => apiError(503, 'The model is overloaded.'),
      stream([chunk([{ text: 'Resposta do reserva.' }], 'STOP')]),
    );
    const { promise } = await turn(conversation.id, 'Olá');
    const message = await promise;
    expect(fake.requests.map((r) => r.model)).toEqual(['fake-a', 'fake-b']);
    expect(message.content).toBe('Resposta do reserva.');
  });

  it('ao trocar de modelo no meio do turno, neutraliza as assinaturas antigas', async () => {
    const conversation = createConversation();
    fake.scripts.push(
      stream([chunk([{ functionCall: { id: 'x', name: 'list_reminders', args: {} }, thoughtSignature: 'sig-a' }], 'STOP')]),
      () => apiError(429, 'Resource has been exhausted (e.g. check quota).'),
      stream([chunk([{ text: 'Sem lembretes.' }], 'STOP')]),
    );
    const { promise } = await turn(conversation.id, 'Tenho lembretes?');
    await promise;
    expect(fake.requests.map((r) => r.model)).toEqual(['fake-a', 'fake-a', 'fake-b']);
    const modelTurn = fake.requests[2].contents.at(-2);
    expect(modelTurn.parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
  });

  it('erro depois do início: emite erro amigável e guarda o parcial', async () => {
    const conversation = createConversation();
    fake.scripts.push(
      stream([chunk([{ text: 'Começando a ' }]), chunk([{ text: 'responder' }])], {
        failAfter: { index: 1, error: apiError(429, 'Resource has been exhausted (e.g. check quota).') },
      }),
    );
    const { events, promise } = await turn(conversation.id, 'Explique a relatividade');
    await expect(promise).rejects.toBeInstanceOf(AgentTurnError);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'quota' });
    const saved = listMessages(conversation.id);
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(saved[1].content).toBe('Começando a');
  });

  it('cancelamento no meio do streaming salva o que foi gerado', async () => {
    const conversation = createConversation();
    const controller = new AbortController();
    fake.scripts.push(stream([chunk([{ text: 'Primeira parte.' }]), chunk([{ text: ' Segunda.' }], 'STOP')], { hangAfter: 1 }));
    const events: ChatStreamEvent[] = [];
    const message = await runAgentTurn({
      conversationId: conversation.id,
      userText: 'Fale bastante',
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'token') controller.abort();
      },
    });
    expect(message.content).toBe('Primeira parte.');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('resposta vazia vira erro do provedor', async () => {
    const conversation = createConversation();
    fake.scripts.push(stream([chunk([], 'SAFETY')]));
    const { events, promise } = await turn(conversation.id, 'Algo estranho');
    await expect(promise).rejects.toMatchObject({ code: 'provider' });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'provider' });
    expect(listMessages(conversation.id).map((m) => m.role)).toEqual(['user']);
  });

  it('sem chave e sem modo demonstração: erro no_api_key com orientação', async () => {
    fake.hasClient = false;
    const conversation = createConversation();
    const { events, promise } = await turn(conversation.id, 'Oi');
    await expect(promise).rejects.toMatchObject({ code: 'no_api_key' });
    expect(events[0]).toMatchObject({ type: 'meta', model: '' });
    const error = events[1];
    expect(error).toMatchObject({ type: 'error', code: 'no_api_key' });
    if (error.type !== 'error') throw new Error('sem erro');
    expect(error.message).toMatch(/Google AI Studio/);
    expect(error.message).toMatch(/Configurações/);
    expect(listMessages(conversation.id).map((m) => m.role)).toEqual(['user']);
    expect(fake.requests).toHaveLength(0);
  });
});
