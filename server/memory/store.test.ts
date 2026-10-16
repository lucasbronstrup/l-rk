import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

import { bus } from '../lib/bus.js';
import type { LarkEvent } from '../../shared/types.js';
import { DEFAULT_SETTINGS, SettingsValidationError, getApiKey, getSettings, updateSettings } from './settings.js';
import {
  createConversation,
  deleteConversation,
  getConversation,
  getOrCreateActiveConversation,
  listConversations,
  updateConversation,
} from './conversations.js';
import { addMessage, countMessages, listMessages, titleFromText, updateMessage } from './messages.js';
import { createMemory, deleteMemory, getMemory, getMemoryStats, listMemories, markAccessed, updateMemory } from './memories.js';
import { createCommitment, deleteCommitment, getCommitment, listCommitments, updateCommitment } from './commitments.js';
import { createReminder, deleteReminder, getDueReminders, listReminders, updateReminder } from './reminders.js';

let events: LarkEvent[] = [];
let unsubscribe: () => void = () => {};
beforeEach(() => {
  events = [];
  unsubscribe = bus.subscribe((e) => events.push(e));
});
afterEach(() => unsubscribe());

describe('configurações', () => {
  it('tem padrões sensatos e nunca expõe a chave', () => {
    const s = getSettings();
    expect(s.userName).toBe('');
    expect(s.voiceName).toBe('Charon');
    expect(s.speakInChat).toBe(false);
    expect(s.showThoughts).toBe(true);
    expect(s.computer).toEqual({ enabled: true, approvalMode: 'ask', favoritePaths: [] });
    expect(s.proactive.checkInEveryHours).toBe(6);
    expect(s.models).toEqual({ chat: '', fast: '', tts: '', live: '', embedding: '' });
    expect(s.timezone).toBe(DEFAULT_SETTINGS.timezone);
    expect(s).not.toHaveProperty('apiKey');
  });

  it('faz merge profundo, persiste e publica o evento', () => {
    const s = updateSettings({ userName: '  Lucas ', proactive: { quietHoursStart: '22:30' }, models: { chat: 'gemini-x' } });
    expect(s.userName).toBe('Lucas');
    expect(s.proactive.quietHoursStart).toBe('22:30');
    expect(s.proactive.quietHoursEnd).toBe('07:00');
    expect(s.models).toEqual({ chat: 'gemini-x', fast: '', tts: '', live: '', embedding: '' });
    expect(getSettings().userName).toBe('Lucas');
    expect(events.some((e) => e.type === 'settings')).toBe(true);
  });

  it('guarda a chave separada e só informa hasApiKey', () => {
    const s = updateSettings({ apiKey: 'AIza-teste' });
    expect(s.hasApiKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain('AIza-teste');
    expect(getApiKey()).toBe('AIza-teste');
    updateSettings({ apiKey: '' });
    expect(getApiKey()).toBe(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
  });

  it('rejeita valores inválidos com mensagem em português', () => {
    expect(() => updateSettings({ timezone: 'Lua/Base' })).toThrow(SettingsValidationError);
    expect(() => updateSettings({ proactive: { quietHoursStart: '25:00' } })).toThrow(/HH:MM/);
    expect(() => updateSettings({ computer: { approvalMode: 'sempre' as never } })).toThrow(/modo de aprovação/);
    expect(getSettings().timezone).toBe(DEFAULT_SETTINGS.timezone);
  });
});

describe('conversas e mensagens', () => {
  it('cria conversa, dá título automático e atualiza updated_at', () => {
    const c = createConversation();
    expect(c.title).toBe('Nova conversa');
    expect(events).toContainEqual(expect.objectContaining({ type: 'conversation', action: 'created' }));

    const later = new Date(Date.now() + 5_000).toISOString();
    addMessage({
      conversationId: c.id,
      role: 'user',
      content: 'me ajuda a **planejar** minha semana de estudos para a prova de cálculo',
      kind: 'chat',
      createdAt: later,
    });
    const updated = getConversation(c.id)!;
    expect(updated.title).toBe('Me ajuda a planejar minha semana…');
    expect(updated.updatedAt).toBe(later);
    expect(updated.messageCount).toBe(1);

    // A segunda mensagem do usuário não muda o título.
    addMessage({ conversationId: c.id, role: 'user', content: 'outra coisa', kind: 'chat' });
    expect(getConversation(c.id)!.title).toBe(updated.title);
  });

  it('gera títulos limpos', () => {
    expect(titleFromText('oi')).toBe('Oi');
    expect(titleFromText('```js\ncode\n```')).toBeNull();
    expect(titleFromText('Qual é a capital da França?')).toBe('Qual é a capital da França');
  });

  it('lista mensagens em ordem cronológica com paginação por before', () => {
    const c = createConversation('Paginação');
    const base = Date.parse('2026-01-01T10:00:00.000Z');
    for (let i = 0; i < 10; i++) {
      addMessage({
        conversationId: c.id,
        role: i % 2 ? 'assistant' : 'user',
        content: `mensagem ${i}`,
        kind: 'chat',
        createdAt: new Date(base + i * 1000).toISOString(),
      });
    }
    const last = listMessages(c.id, { limit: 4 });
    expect(last.map((m) => m.content)).toEqual(['mensagem 6', 'mensagem 7', 'mensagem 8', 'mensagem 9']);
    const page = listMessages(c.id, { limit: 4, before: last[0].createdAt });
    expect(page.map((m) => m.content)).toEqual(['mensagem 2', 'mensagem 3', 'mensagem 4', 'mensagem 5']);
    expect(countMessages(c.id)).toBe(10);
    expect(getConversation(c.id)!.title).toBe('Paginação');
  });

  it('atualiza conteúdo, raciocínio e ferramentas', () => {
    const c = createConversation();
    const m = addMessage({ conversationId: c.id, role: 'assistant', content: '', kind: 'chat' });
    expect(m.toolCalls).toEqual([]);
    expect(m.thoughts).toBeNull();
    const call = { id: 't1', name: 'recall', label: 'Consultando', args: {}, status: 'done' as const, risk: 'safe' as const };
    const u = updateMessage(m.id, { content: 'Pronto.', thoughts: 'pensei', toolCalls: [call] })!;
    expect(u.content).toBe('Pronto.');
    expect(u.thoughts).toBe('pensei');
    expect(u.toolCalls).toEqual([call]);
    expect(updateMessage('inexistente', { content: 'x' })).toBeNull();
  });

  it('recusa mensagem para conversa inexistente', () => {
    expect(() => addMessage({ conversationId: 'nada', role: 'user', content: 'x', kind: 'chat' })).toThrow(/Conversa não encontrada/);
  });

  it('renomeia, lista, apaga em cascata e escolhe a conversa ativa', () => {
    const c = createConversation('Temporária');
    addMessage({ conversationId: c.id, role: 'user', content: 'olá', kind: 'chat', createdAt: new Date(Date.now() + 60_000).toISOString() });
    expect(getOrCreateActiveConversation().id).toBe(c.id);
    expect(updateConversation(c.id, { title: '  Renomeada  ', summary: 'resumo' })).toMatchObject({ title: 'Renomeada', summary: 'resumo' });
    expect(listConversations().map((x) => x.id)).toContain(c.id);
    expect(deleteConversation(c.id)).toBe(true);
    expect(getConversation(c.id)).toBeNull();
    expect(countMessages(c.id)).toBe(0);
    expect(deleteConversation(c.id)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'conversation', action: 'deleted' }));
  });
});

describe('memórias', () => {
  it('CRUD completo com eventos', () => {
    const m = createMemory({ content: '  Lucas   adora  pão de queijo ', category: 'preference', importance: 9 });
    expect(m.content).toBe('Lucas adora pão de queijo');
    expect(m.importance).toBe(5);
    expect(m.source).toBe('manual');
    expect(m.pinned).toBe(false);
    const u = updateMemory(m.id, { importance: 2, pinned: true })!;
    expect(u).toMatchObject({ importance: 2, pinned: true });
    expect(() => updateMemory(m.id, { category: 'nada' as never })).toThrow(/Categoria/);
    expect(() => createMemory({ content: '   ', category: 'fact' })).toThrow(/vazio/);
    expect(deleteMemory(m.id)).toBe(true);
    expect(getMemory(m.id)).toBeNull();
    expect(events.filter((e) => e.type === 'memory').map((e) => (e as { action: string }).action)).toEqual([
      'created',
      'updated',
      'deleted',
    ]);
  });

  it('busca textual ignora acentos nos dois sentidos e filtra por categoria', () => {
    createMemory({ content: 'Lucas quer melhorar a memória de trabalho', category: 'goal' });
    createMemory({ content: 'A memoria do notebook é de 16 GB', category: 'fact' });
    createMemory({ content: 'Prefere reuniões curtas', category: 'work' });
    expect(listMemories({ q: 'memoria' }).total).toBe(2);
    expect(listMemories({ q: 'memória' }).total).toBe(2);
    expect(listMemories({ q: 'MEMÓRIA', category: 'goal' }).items.map((m) => m.category)).toEqual(['goal']);
    expect(listMemories({ q: 'reuniao' }).items[0].content).toBe('Prefere reuniões curtas');
    expect(listMemories({ q: '"; DROP TABLE xyz; --' }).total).toBe(0);
    expect(listMemories({ q: 'memórias' }).total).toBe(2);
    expect(listMemories({ q: '*** ( ) :' }).total).toBe(0);
    expect(listMemories({ category: 'work' }).total).toBe(1);
    expect(listMemories({ limit: 1 }).items).toHaveLength(1);
  });

  it('registra acesso e calcula estatísticas', () => {
    const m = createMemory({ content: 'Mora em Belo Horizonte', category: 'fact' });
    markAccessed([m.id, m.id]);
    const accessed = getMemory(m.id)!;
    expect(accessed.accessCount).toBe(1);
    expect(accessed.lastAccessedAt).not.toBeNull();
    const stats = getMemoryStats();
    expect(stats.memories).toBeGreaterThan(0);
    expect(stats.byCategory.fact).toBeGreaterThan(0);
    expect(stats.conversations).toBeGreaterThan(0);
    expect(stats.firstInteractionAt).not.toBeNull();
  });
});

describe('compromissos', () => {
  it('cria, conclui, reabre, lista e apaga', () => {
    const a = createCommitment({ description: 'Ir à academia', dueAt: '2026-10-17T07:00:00-03:00' });
    expect(a.dueAt).toBe('2026-10-17T10:00:00.000Z');
    expect(a.status).toBe('pending');
    const b = createCommitment({ description: 'Ligar para a mãe' });
    const c = createCommitment({ description: 'Estudar inglês', dueAt: '2026-10-16T20:00:00Z' });

    expect(listCommitments({ status: 'open' }).map((x) => x.id)).toEqual([c.id, a.id, b.id]);

    const done = updateCommitment(a.id, { status: 'done', notes: 'foi ótimo' })!;
    expect(done.completedAt).not.toBeNull();
    expect(done.notes).toBe('foi ótimo');
    expect(updateCommitment(a.id, { status: 'pending' })!.completedAt).toBeNull();
    expect(updateCommitment(b.id, { lastCheckedAt: '2026-10-16T12:00:00Z', checkCount: 2 })).toMatchObject({
      lastCheckedAt: '2026-10-16T12:00:00.000Z',
      checkCount: 2,
    });
    expect(() => createCommitment({ description: 'x', dueAt: 'amanhã' })).toThrow(/Data inválida/);
    expect(() => listCommitments({ status: 'talvez' as never })).toThrow(/Status/);
    updateCommitment(c.id, { status: 'missed' });
    expect(listCommitments({ status: 'missed' }).map((x) => x.id)).toEqual([c.id]);
    expect(listCommitments()).toHaveLength(3);
    expect(deleteCommitment(b.id)).toBe(true);
    expect(getCommitment(b.id)).toBeNull();
    expect(events.filter((e) => e.type === 'commitment').length).toBeGreaterThanOrEqual(7);
  });
});

describe('lembretes', () => {
  it('cria, lista, encontra os vencidos e cancela', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const past = createReminder({ text: 'Beber água', dueAt: '2026-10-16T11:59:00Z' });
    const future = createReminder({ text: 'Reunião', dueAt: '2026-10-16T09:30:00-03:00', recurrence: 'weekdays' });
    expect(future.dueAt).toBe('2026-10-16T12:30:00.000Z');
    expect(getDueReminders(now).map((r) => r.id)).toEqual([past.id]);
    updateReminder(past.id, { status: 'fired', firedAt: now.toISOString() });
    expect(getDueReminders(now)).toHaveLength(0);
    expect(listReminders({ status: 'scheduled' }).map((r) => r.id)).toEqual([future.id]);
    expect(listReminders({ from: '2026-10-16T12:10:00Z', to: '2026-10-16T13:00:00Z' }).map((r) => r.id)).toEqual([future.id]);
    expect(() => createReminder({ text: 'x', dueAt: 'ontem' })).toThrow(/Data inválida/);
    expect(() => createReminder({ text: 'x', dueAt: now.toISOString(), recurrence: 'anual' as never })).toThrow(/Recorrência/);
    expect(updateReminder(future.id, { status: 'cancelled' })!.status).toBe('cancelled');
    expect(deleteReminder(future.id)).toBe(true);
    expect(events.filter((e) => e.type === 'reminder').map((e) => (e as { action: string }).action)).toEqual([
      'created',
      'created',
      'updated',
      'updated',
      'deleted',
    ]);
  });
});
