import { afterAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  process.env.LARK_MOCK = '1';
});

import { createConversation, getConversation } from '../memory/conversations.js';
import { listMessages } from '../memory/messages.js';
import { listCommitments } from '../memory/commitments.js';
import { listReminders } from '../memory/reminders.js';
import { listMemories } from '../memory/memories.js';
import { updateSettings } from '../memory/settings.js';
import { disposeMathEngine } from '../tools/utility.js';
import { chatRoutes } from '../routes/chat.js';
import { runAgentTurn } from './loop.js';
import { planMockActions } from './mock.js';
import { cancelPostTurn } from './post-turn.js';
import type { ChatStreamEvent } from '../../shared/types.js';

updateSettings({ timezone: 'America/Sao_Paulo' });

afterAll(async () => {
  cancelPostTurn();
  await disposeMathEngine();
});

async function turn(conversationId: string, userText: string, signal?: AbortSignal) {
  const events: ChatStreamEvent[] = [];
  const message = await runAgentTurn({ conversationId, userText, onEvent: (e) => events.push(e), signal });
  return { events, message };
}

describe('planMockActions', () => {
  const now = new Date('2026-10-16T15:00:00Z');
  const tz = 'America/Sao_Paulo';

  it('lembrete daqui a 1 hora, com offset do fuso', () => {
    const [action] = planMockActions('Me lembra de ligar para o dentista', now, tz);
    expect(action.name).toBe('create_reminder');
    expect(action.args.text).toBe('Ligar para o dentista');
    expect(action.args.due_at).toBe('2026-10-16T13:00:00-03:00');
  });

  it('entende prazos relativos simples e tira o prazo do texto do lembrete', () => {
    const [water] = planMockActions('Me lembre de beber água daqui a uma hora', now, tz);
    expect(water.args.text).toBe('Beber água');
    expect(water.args.due_at).toBe('2026-10-16T13:00:00-03:00');
    const [call] = planMockActions('Me avisa em 15 minutos de ligar pra Ana', now, tz);
    expect(call.args.text).toBe('Ligar pra Ana');
    expect(call.args.due_at).toBe('2026-10-16T12:15:00-03:00');
  });

  it('promessa com prazo amanhã', () => {
    const [action] = planMockActions('Prometo que vou estudar cálculo amanhã', now, tz);
    expect(action.name).toBe('create_commitment');
    expect(action.args.description).toBe('Vou estudar cálculo amanhã');
    expect(action.args.due_at).toBe('2026-10-17T23:59:00');
  });

  it('nome, fatos, recordação e sistema', () => {
    expect(planMockActions('Oi, meu nome é ana Paula e gosto de chá', now, tz)[0]).toEqual({
      name: 'remember',
      args: { content: 'O usuário prefere ser chamado de Ana Paula', category: 'person', importance: 5 },
    });
    expect(planMockActions('Lembre-se que eu sou alérgico a camarão', now, tz)[0].args.content).toBe('Eu sou alérgico a camarão');
    expect(planMockActions('Você lembra de mim?', now, tz)[0].name).toBe('recall');
    expect(planMockActions('Como está o computador?', now, tz).map((a) => a.name)).toEqual(['system_status']);
    expect(planMockActions('Qual a capital da França?', now, tz)).toEqual([]);
    expect(planMockActions('Execute o comando `echo olá`', now, tz)).toEqual([{ name: 'run_command', args: { command: 'echo olá' } }]);
  });
});

describe('runAgentTurn em modo demonstração', () => {
  it('salva as mensagens e cria um lembrete de verdade', async () => {
    const conversation = createConversation();
    const { events, message } = await turn(conversation.id, 'Me lembra de regar as plantas');

    const meta = events[0];
    expect(meta.type).toBe('meta');
    if (meta.type !== 'meta') throw new Error('meta ausente');
    expect(meta.conversationId).toBe(conversation.id);
    expect(meta.assistantMessageId).toBe(message.id);

    expect(events.some((e) => e.type === 'thought')).toBe(true);
    const tokens = events.filter((e): e is Extract<ChatStreamEvent, { type: 'token' }> => e.type === 'token');
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens.map((t) => t.text).join('').trimEnd()).toBe(message.content);
    expect(events.at(-1)).toEqual({ type: 'done', message });

    const toolEvents = events.filter((e): e is Extract<ChatStreamEvent, { type: 'tool' }> => e.type === 'tool');
    expect(toolEvents.at(-1)?.call).toMatchObject({ name: 'create_reminder', status: 'done' });

    const reminders = listReminders({ status: 'scheduled' });
    expect(reminders.map((r) => r.text)).toContain('Regar as plantas');
    const due = new Date(reminders.find((r) => r.text === 'Regar as plantas')!.dueAt).getTime();
    expect(Math.abs(due - (Date.now() + 3_600_000))).toBeLessThan(120_000);

    const saved = listMessages(conversation.id);
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(saved[0].content).toBe('Me lembra de regar as plantas');
    expect(saved[1].id).toBe(message.id);
    expect(saved[1].toolCalls?.[0]).toMatchObject({ name: 'create_reminder', status: 'done' });
    expect(saved[1].thoughts).toMatch(/Modo demonstração/);
    expect(message.content).toMatch(/Na hora certa, eu te chamo/);
    // Título automático a partir da primeira fala.
    expect(getConversation(conversation.id)?.title).toBe('Me lembra de regar as plantas');
  });

  it('registra uma promessa e uma memória', async () => {
    const conversation = createConversation();
    await turn(conversation.id, 'Prometo que vou correr 5 km amanhã');
    expect(listCommitments({ status: 'open' }).map((c) => c.description)).toContain('Vou correr 5 km amanhã');

    await turn(conversation.id, 'Meu nome é Lucas');
    expect(listMemories({ q: 'chamado Lucas' }).items.map((m) => m.content)).toContain('O usuário prefere ser chamado de Lucas');
    expect(listMessages(conversation.id)).toHaveLength(4);
  });

  it('cancelamento salva a resposta parcial', async () => {
    const conversation = createConversation();
    const controller = new AbortController();
    const events: ChatStreamEvent[] = [];
    const promise = runAgentTurn({
      conversationId: conversation.id,
      userText: 'Conte uma história longa sobre o mar',
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'token' && events.filter((x) => x.type === 'token').length === 3) controller.abort();
      },
    });
    const message = await promise;
    expect(message.content.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'token')).toHaveLength(3);
    expect(listMessages(conversation.id).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('rejeita conversa inexistente com evento de erro', async () => {
    const events: ChatStreamEvent[] = [];
    await expect(runAgentTurn({ conversationId: 'nao-existe', userText: 'oi', onEvent: (e) => events.push(e) })).rejects.toMatchObject({
      name: 'AgentTurnError',
    });
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'internal' })]);
  });
});

/** Lê um corpo SSE e devolve os eventos (event: + data:). */
async function readSse(res: Response): Promise<{ event: string; data: ChatStreamEvent }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      return { event, data: JSON.parse(data) as ChatStreamEvent };
    });
}

describe('rotas do chat', () => {
  it('POST /chat responde SSE com event = type e data = evento inteiro', async () => {
    const conversation = createConversation();
    const res = await chatRoutes.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id, message: 'Olá, Lärk' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(res);
    expect(events[0].event).toBe('meta');
    for (const e of events) expect(e.data.type).toBe(e.event);
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    if (done.data.type !== 'done') throw new Error('sem done');
    expect(done.data.message.conversationId).toBe(conversation.id);
    expect(listMessages(conversation.id)).toHaveLength(2);
  });

  it('POST /chat sem conversa usa a conversa ativa', async () => {
    const res = await chatRoutes.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Bom dia' }),
    });
    const events = await readSse(res);
    const meta = events[0].data;
    if (meta.type !== 'meta') throw new Error('sem meta');
    expect(getConversation(meta.conversationId)).not.toBeNull();
  });

  it('valida o corpo e a conversa', async () => {
    const empty = await chatRoutes.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'A mensagem está vazia.' });

    const missing = await chatRoutes.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'nao-existe', message: 'oi' }),
    });
    expect(missing.status).toBe(404);
  });

  it('POST /chat/stop interrompe o turno em andamento', async () => {
    const conversation = createConversation();
    const pending = chatRoutes.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id, message: 'Fale sobre a história de Roma' }),
    });
    const res = await pending;
    // Espera o primeiro token chegar antes de parar.
    await new Promise((r) => setTimeout(r, 250));
    const stop = await chatRoutes.request('/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id }),
    });
    expect(await stop.json()).toEqual({ ok: true, stopped: true });
    const events = await readSse(res);
    expect(events.at(-1)?.event).toBe('done');
    const again = await chatRoutes.request('/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id }),
    });
    expect(await again.json()).toEqual({ ok: true, stopped: false });
  });
});
