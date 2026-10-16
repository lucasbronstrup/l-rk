import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  process.env.LARK_MOCK = '1';
});

import { Hono } from 'hono';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { apiRoutes } from './index.js';
import { subscriberCount } from '../lib/sse.js';
import { bus } from '../lib/bus.js';
import { requestApproval, cancelAllApprovals } from '../tools/approvals.js';
import type { ChatMessage, Commitment, Conversation, HealthInfo, Memory, Reminder, Settings } from '../../shared/types.js';

const app = new Hono().route('/api', apiRoutes);

function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(`/api${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function resetDb() {
  db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM memories; DELETE FROM commitments; DELETE FROM reminders;');
}

beforeEach(() => {
  config.password = '';
  resetDb();
});

afterAll(() => {
  cancelAllApprovals();
});

describe('saúde e modelos', () => {
  it('GET /health devolve HealthInfo em modo demonstração', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    const h = await json<HealthInfo>(res);
    expect(h.ok).toBe(true);
    expect(h.mock).toBe(true);
    expect(h.authRequired).toBe(false);
    expect(typeof h.version).toBe('string');
    expect(h.activeModels.chat).toBeTruthy();
  });

  it('GET /models lista modelos', async () => {
    const res = await call('/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('rotas desconhecidas respondem 404 em JSON', async () => {
    const res = await call('/nao-existe');
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toMatch(/não encontrada/);
  });
});

describe('conversas', () => {
  it('cria, lista, renomeia, lê mensagens e apaga', async () => {
    const created = await json<Conversation>(await call('/conversations', { method: 'POST', body: { title: 'Plano de estudos' } }));
    expect(created.title).toBe('Plano de estudos');

    const list = await json<Conversation[]>(await call('/conversations'));
    expect(list.map((c) => c.id)).toContain(created.id);

    const active = await json<Conversation>(await call('/conversations/active'));
    expect(active.id).toBe(created.id);

    const renamed = await call(`/conversations/${created.id}`, { method: 'PATCH', body: { title: 'Estudos' } });
    expect(renamed.status).toBe(200);
    expect((await json<Conversation>(renamed)).title).toBe('Estudos');

    const msgs = await call(`/conversations/${created.id}/messages?limit=10`);
    expect(msgs.status).toBe(200);
    expect(await json<ChatMessage[]>(msgs)).toEqual([]);

    expect((await call(`/conversations/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/conversations/${created.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await call(`/conversations/${created.id}/messages`)).status).toBe(404);
  });

  it('valida o corpo e a query', async () => {
    expect((await call('/conversations', { method: 'POST', body: '{nao é json' })).status).toBe(400);
    const c = await json<Conversation>(await call('/conversations', { method: 'POST', body: {} }));
    expect((await call(`/conversations/${c.id}`, { method: 'PATCH', body: {} })).status).toBe(400);
    expect((await call(`/conversations/${c.id}/messages?before=ontem`)).status).toBe(400);
    expect((await call('/conversations?limit=abc')).status).toBe(400);
  });
});

describe('memórias', () => {
  it('CRUD completo com validação', async () => {
    const bad = await call('/memories', { method: 'POST', body: { content: '   ' } });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toBeTruthy();

    const res = await call('/memories', {
      method: 'POST',
      body: { content: 'O usuário adora café coado às 7h', category: 'preference', importance: 4 },
    });
    expect(res.status).toBe(201);
    const memory = await json<Memory>(res);
    expect(memory.source).toBe('manual');

    const list = await json<{ items: Memory[]; total: number }>(await call('/memories?category=preference'));
    expect(list.total).toBe(1);
    expect((await call('/memories?category=invalida')).status).toBe(400);

    const found = await json<{ items: Memory[] }>(await call('/memories?q=cafe'));
    expect(found.items[0]?.id).toBe(memory.id);

    const stats = await json<{ memories: number }>(await call('/memories/stats'));
    expect(stats.memories).toBe(1);

    const hits = await json<unknown[]>(await call('/memories/search?q=café'));
    expect(hits.length).toBeGreaterThan(0);

    const patched = await json<Memory>(await call(`/memories/${memory.id}`, { method: 'PATCH', body: { pinned: true } }));
    expect(patched.pinned).toBe(true);
    expect((await call(`/memories/${memory.id}`, { method: 'PATCH', body: { importance: 9 } })).status).toBe(400);

    expect((await call(`/memories/${memory.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/memories/${memory.id}`)).status).toBe(404);
  });
});

describe('promessas e lembretes', () => {
  it('compromissos: cria, filtra, conclui e reinicia cobranças ao mudar o prazo', async () => {
    const res = await call('/commitments', { method: 'POST', body: { description: 'Correr 5 km', dueAt: '2026-10-20T07:00:00-03:00' } });
    expect(res.status).toBe(201);
    const c = await json<Commitment>(res);
    expect(c.dueAt).toBe('2026-10-20T10:00:00.000Z');

    db.prepare('UPDATE commitments SET check_count = 2, last_checked_at = ? WHERE id = ?').run(new Date().toISOString(), c.id);
    const moved = await json<Commitment>(
      await call(`/commitments/${c.id}`, { method: 'PATCH', body: { dueAt: '2026-10-22T07:00:00-03:00' } }),
    );
    expect(moved.checkCount).toBe(0);
    expect(moved.lastCheckedAt).toBeNull();

    const open = await json<Commitment[]>(await call('/commitments?status=open'));
    expect(open).toHaveLength(1);

    const done = await json<Commitment>(await call(`/commitments/${c.id}`, { method: 'PATCH', body: { status: 'done' } }));
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeTruthy();
    expect((await call('/commitments?status=talvez')).status).toBe(400);
    expect((await call('/commitments', { method: 'POST', body: { description: 'x', dueAt: 'amanhã' } })).status).toBe(400);
    expect((await call(`/commitments/${c.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('lembretes: cria, adia um disparado (volta a agendado) e apaga', async () => {
    const res = await call('/reminders', { method: 'POST', body: { text: 'Ligar para a mãe', dueAt: '2026-10-17T18:00:00Z', recurrence: 'weekly' } });
    expect(res.status).toBe(201);
    const r = await json<Reminder>(res);
    db.prepare("UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);

    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const snoozed = await json<Reminder>(await call(`/reminders/${r.id}`, { method: 'PATCH', body: { dueAt: future } }));
    expect(snoozed.status).toBe('scheduled');
    expect(snoozed.firedAt).toBeNull();

    expect((await call('/reminders', { method: 'POST', body: { text: 'x', dueAt: '2026-10-17T18:00:00Z', recurrence: 'anual' } })).status).toBe(400);
    expect(await json<Reminder[]>(await call('/reminders?status=scheduled'))).toHaveLength(1);
    expect((await call(`/reminders/${r.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/reminders/${r.id}`, { method: 'PATCH', body: { text: 'y' } })).status).toBe(404);
  });
});

describe('configurações, aprovações e sistema', () => {
  it('GET/PUT /settings com validação (400) e sem expor a chave', async () => {
    const s = await json<Settings>(await call('/settings'));
    expect(s).not.toHaveProperty('apiKey');
    const updated = await json<Settings>(await call('/settings', { method: 'PUT', body: { userName: 'Lucas', proactive: { checkInEveryHours: 4 } } }));
    expect(updated.userName).toBe('Lucas');
    expect(updated.proactive.checkInEveryHours).toBe(4);
    expect(updated.proactive.quietHoursStart).toBe('23:00');
    const bad = await call('/settings', { method: 'PUT', body: { proactive: { quietHoursStart: '25:99' } } });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toMatch(/HH:MM/);
  });

  it('aprovações: lista e resolve; id desconhecido dá 404', async () => {
    const decision = requestApproval({ toolName: 'delete_file', label: 'Apagando arquivo', risk: 'dangerous', description: 'Apagar teste.txt', args: {} }, 10_000);
    const pending = await json<{ id: string }[]>(await call('/approvals'));
    expect(pending).toHaveLength(1);
    expect((await call(`/approvals/${pending[0].id}`, { method: 'POST', body: { approved: 'sim' } })).status).toBe(400);
    expect((await call(`/approvals/${pending[0].id}`, { method: 'POST', body: { approved: true } })).status).toBe(200);
    expect(await decision).toBe(true);
    expect((await call('/approvals/inexistente', { method: 'POST', body: { approved: false } })).status).toBe(404);
  });
});

describe('briefing', () => {
  it('gera no máximo um a cada 6 h, a menos que forçado', async () => {
    const first = await json<{ message: ChatMessage }>(await call('/briefing', { method: 'POST', body: {} }));
    expect(first.message.kind).toBe('briefing');
    expect(first.message.content).toMatch(/Bo[ma] (dia|tarde|noite|madrugada)/);
    const second = await json<{ message: ChatMessage }>(await call('/briefing', { method: 'POST', body: {} }));
    expect(second.message.id).toBe(first.message.id);
    const forced = await json<{ message: ChatMessage }>(await call('/briefing', { method: 'POST', body: { force: true } }));
    expect(forced.message.id).not.toBe(first.message.id);
    expect((await call('/briefing', { method: 'POST', body: { conversationId: 'nao-existe' } })).status).toBe(404);
  });
});

describe('eventos (SSE)', () => {
  it('envia hello ao conectar, retransmite o bus e libera o assinante ao desconectar', async () => {
    const res = await call('/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: hello')) text += decoder.decode((await reader.read()).value);
    expect(text).toContain('"type":"hello"');
    expect(subscriberCount()).toBe(1);

    bus.publish({ type: 'approval_resolved', id: 'abc', approved: true });
    while (!text.includes('approval_resolved')) text += decoder.decode((await reader.read()).value);
    expect(text).toContain('event: approval_resolved\ndata: {"type":"approval_resolved","id":"abc","approved":true}');

    await reader.cancel();
    await vi.waitFor(() => expect(subscriberCount()).toBe(0));
  });
});

describe('backup', () => {
  it('exporta tudo e importa mesclando (ignora ids existentes)', async () => {
    const conv = await json<Conversation>(await call('/conversations', { method: 'POST', body: { title: 'Backup' } }));
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, kind, created_at) VALUES ('m1', ?, 'user', 'oi Lärk', 'chat', ?)",
    ).run(conv.id, new Date().toISOString());
    await call('/memories', { method: 'POST', body: { content: 'Mora em Curitiba', category: 'fact' } });
    await call('/commitments', { method: 'POST', body: { description: 'Ler 20 páginas' } });
    await call('/reminders', { method: 'POST', body: { text: 'Reunião', dueAt: '2026-11-01T12:00:00Z' } });

    const res = await call('/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="lark-backup-\d{4}-\d{2}-\d{2}\.json"/);
    const backup = await json<Record<string, unknown[]> & { settings: Record<string, unknown> }>(res);
    expect(backup.conversations).toHaveLength(1);
    expect(backup.messages).toHaveLength(1);
    expect(backup.memories).toHaveLength(1);
    expect(backup.commitments).toHaveLength(1);
    expect(backup.reminders).toHaveLength(1);
    expect(backup.settings).not.toHaveProperty('hasApiKey');
    expect(JSON.stringify(backup)).not.toMatch(/apiKey/);

    // Reimportar o mesmo arquivo não duplica nada.
    const again = await json<{ imported: Record<string, number>; skipped: number }>(await call('/import', { method: 'POST', body: backup }));
    expect(again.imported.conversas).toBe(0);
    expect(again.skipped).toBe(5);

    // Num banco vazio, tudo volta.
    resetDb();
    const restored = await json<{ imported: Record<string, number> }>(await call('/import', { method: 'POST', body: backup }));
    expect(restored.imported).toMatchObject({ conversas: 1, mensagens: 1, 'memórias': 1, promessas: 1, lembretes: 1 });
    const msgs = await json<ChatMessage[]>(await call(`/conversations/${conv.id}/messages`));
    expect(msgs[0].content).toBe('oi Lärk');
    const found = await json<{ items: Memory[] }>(await call('/memories?q=curitiba'));
    expect(found.items).toHaveLength(1);
  });

  it('recusa arquivos que não são backup do Lärk', async () => {
    expect((await call('/import', { method: 'POST', body: [1, 2] })).status).toBe(400);
    expect((await call('/import', { method: 'POST', body: { format: 'outro-app' } })).status).toBe(400);
    expect((await call('/import', { method: 'POST', body: 'nada' })).status).toBe(400);
  });
});

describe('proteção de origem', () => {
  it('bloqueia escrita vinda de outro site e permite a interface local', async () => {
    const evil = await call('/memories', { method: 'POST', body: { content: 'x', category: 'fact' }, headers: { Origin: 'https://site-malicioso.com' } });
    expect(evil.status).toBe(403);
    const dev = await call('/memories', { method: 'POST', body: { content: 'x', category: 'fact' }, headers: { Origin: 'http://localhost:5173' } });
    expect(dev.status).toBe(201);
  });

  it('bloqueia hosts estranhos sem senha (DNS rebinding)', async () => {
    const res = await app.request('http://ataque.exemplo.com/api/settings');
    expect(res.status).toBe(403);
  });
});
