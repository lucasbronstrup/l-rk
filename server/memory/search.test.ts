import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  process.env.LARK_MOCK = '0';
});

/**
 * Embeddings falsos e determinísticos: "saco de palavras" com hashing, mais uma tabela de
 * sinônimos para simular semântica (ex.: "cão" ≈ "cachorro") sem chamar a API real.
 */
const fake = vi.hoisted(() => {
  const SYNONYMS: Record<string, string> = { cao: 'cachorro', pet: 'cachorro', felino: 'gato', automovel: 'carro' };
  /** Palavras "de conceito" pesam mais, como num embedding real (o assunto domina o vetor). */
  const CONCEPTS = new Set(['cachorro', 'gato', 'carro']);
  const DIMS = 256;
  const embedText = (text: string): number[] => {
    const v = new Array(DIMS).fill(0);
    const words = text
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2);
    for (const raw of words) {
      const w = SYNONYMS[raw] ?? raw;
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % DIMS] += CONCEPTS.has(w) ? 3 : 1;
    }
    return v;
  };
  const state = { enabled: false, calls: 0, failWith: null as null | { status: number; message: string } };
  const client = {
    models: {
      embedContent: async (params: { contents: string[] }) => {
        state.calls++;
        if (state.failWith) {
          const err = Object.assign(new Error(state.failWith.message), { status: state.failWith.status });
          throw err;
        }
        return { embeddings: params.contents.map((t) => ({ values: embedText(t) })) };
      },
    },
  };
  return { state, client };
});

vi.mock('../llm/gemini.js', () => ({
  getClient: () => (fake.state.enabled ? fake.client : null),
  resolveModel: async () => 'fake-embedding-001',
}));

import { createConversation } from './conversations.js';
import { addMessage, updateMessage } from './messages.js';
import { createMemory, getMemory, listMemories, updateMemory } from './memories.js';
import { findSimilarMemories, findSimilarMemoriesScored, getCoreMemories, isNearDuplicate, searchMemory } from './search.js';
import { embed, resetEmbeddingState, runEmbeddingCycle } from './embeddings.js';
import { db } from '../db/index.js';
import { memoryTools } from '../tools/memory-tools.js';
import type { ToolContext } from '../tools/types.js';

const ctx = (conversationId = 'conversa-atual'): ToolContext => ({ conversationId, mode: 'text', emit: () => {} });
const tool = (name: string) => {
  const t = memoryTools.find((x) => x.name === name);
  if (!t) throw new Error(`ferramenta ${name} ausente`);
  return t;
};
const pending = (table: 'memories' | 'messages') =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE embedding IS NULL AND embedding_model IS NULL` +
          (table === 'memories' ? ' AND archived = 0' : ''),
      )
      .get() as { n: number }
  ).n;

beforeEach(() => {
  fake.state.enabled = false;
  fake.state.failWith = null;
  fake.state.calls = 0;
  resetEmbeddingState();
});

describe('busca híbrida sem embeddings (apenas FTS)', () => {
  it('encontra memórias e trechos de conversas, ignorando acentos', async () => {
    const atual = createConversation('Atual');
    const antiga = createConversation('Antiga');
    const m1 = createMemory({ content: 'Lucas é alérgico a camarão', category: 'health', importance: 5 });
    createMemory({ content: 'Lucas gosta de praia no verão', category: 'preference', importance: 2 });
    addMessage({ conversationId: antiga.id, role: 'user', content: 'Ontem comi camarao e passei mal, que susto!', kind: 'chat' });
    addMessage({ conversationId: atual.id, role: 'user', content: 'Camarão de novo no cardápio de hoje', kind: 'chat' });
    addMessage({ conversationId: antiga.id, role: 'system', content: 'camarão (mensagem de sistema)', kind: 'chat' });

    const onlyMemories = await searchMemory('camarão');
    expect(onlyMemories.map((h) => h.type)).toEqual(['memory']);
    expect(onlyMemories[0]).toMatchObject({ id: m1.id, category: 'health' });
    expect(onlyMemories[0].score).toBeGreaterThan(0);
    expect(onlyMemories[0].score).toBeLessThanOrEqual(1);

    const withMessages = await searchMemory('CAMARAO', { includeMessages: true, excludeConversationId: atual.id });
    expect(withMessages.map((h) => h.type).sort()).toEqual(['memory', 'message']);
    const msg = withMessages.find((h) => h.type === 'message')!;
    expect(msg.content).toBe('Usuário: Ontem comi camarao e passei mal, que susto!');
    expect(msg.conversationId).toBe(antiga.id);

    // A busca registra o acesso às memórias recuperadas.
    expect(getMemory(m1.id)!.accessCount).toBeGreaterThanOrEqual(2);
    expect(fake.state.calls).toBe(0);
  });

  it('prioriza memórias mais importantes em empate textual', async () => {
    const low = createMemory({ content: 'Projeto Atlas usa React', category: 'project', importance: 1 });
    const high = createMemory({ content: 'Projeto Atlas é prioridade máxima', category: 'project', importance: 5 });
    const hits = await searchMemory('atlas');
    expect(hits.map((h) => h.id).slice(0, 2)).toEqual([high.id, low.id]);
  });

  it('consulta vazia ou só pontuação não quebra', async () => {
    expect(await searchMemory('   ')).toEqual([]);
    expect(await searchMemory('?!*"()')).toEqual([]);
  });

  it('exclui memórias arquivadas', async () => {
    const m = createMemory({ content: 'Senha do wifi é girassol', category: 'fact' });
    db.prepare('UPDATE memories SET archived = 1 WHERE id = ?').run(m.id);
    expect((await searchMemory('girassol')).map((h) => h.id)).not.toContain(m.id);
    expect(listMemories({ q: 'girassol' }).total).toBe(0);
  });

  it('getCoreMemories traz fixadas e importantes, nessa ordem', () => {
    const pinned = createMemory({ content: 'Chamar o usuário de chefe', category: 'preference', importance: 2, pinned: true });
    const core = getCoreMemories(50);
    expect(core[0].id).toBe(pinned.id);
    expect(core.every((m) => m.pinned || m.importance >= 4)).toBe(true);
    expect(core.some((m) => m.content.includes('alérgico'))).toBe(true);
  });

  it('embed devolve null sem cliente', async () => {
    expect(await embed(['texto qualquer'])).toBeNull();
    expect(await runEmbeddingCycle()).toBe(0);
  });
});

describe('deduplicação (remember)', () => {
  it('atualiza a memória quase igual em vez de duplicar', async () => {
    const remember = tool('remember');
    const first = await remember.execute({ content: 'Lucas toma café sem açúcar', category: 'preference', importance: 3 }, ctx());
    expect(first.output.action).toBe('created');
    const second = await remember.execute(
      { content: 'Lucas toma café sem açúcar pela manhã', category: 'preference', importance: 4 },
      ctx(),
    );
    expect(second.output.action).toBe('updated');
    expect(listMemories({ q: 'café açúcar' }).total).toBe(1);
    const stored = listMemories({ q: 'café' }).items[0];
    expect(stored.content).toBe('Lucas toma café sem açúcar pela manhã');
    expect(stored.importance).toBe(4);

    // Algo apenas relacionado vira uma memória nova.
    const third = await remember.execute({ content: 'Lucas toma chá de camomila à noite', category: 'preference' }, ctx());
    expect(third.output.action).toBe('created');
  });

  it('não sobrescreve fatos parecidos com nomes ou números diferentes', async () => {
    const remember = tool('remember');
    const a = await remember.execute({ content: 'Lucas tem um irmão chamado Pedro', category: 'person' }, ctx());
    const b = await remember.execute({ content: 'Lucas tem um irmão chamado João', category: 'person' }, ctx());
    expect([a.output.action, b.output.action]).toEqual(['created', 'created']);
    const c = await remember.execute({ content: 'Lucas tem um irmão chamado Pedro, que mora em Recife', category: 'person' }, ctx());
    expect(c.output.action).toBe('updated');
    expect(listMemories({ q: 'irmão' }).total).toBe(2);
  });

  it('findSimilarMemories mede similaridade lexical', async () => {
    const similar = await findSimilarMemoriesScored('Lucas toma café sem açúcar de manhã');
    expect(similar[0].memory.content).toContain('café');
    expect(isNearDuplicate(similar[0])).toBe(true);
    expect(await findSimilarMemories('assunto completamente diferente xyz')).toEqual([]);
  });

  it('rejeita argumentos inválidos com mensagem clara', async () => {
    await expect(tool('remember').execute({ content: '', category: 'fact' }, ctx())).rejects.toThrow(/Argumentos inválidos/);
    await expect(tool('remember').execute({ content: 'x', category: 'banana' }, ctx())).rejects.toThrow(/categoria/);
    await expect(tool('forget').execute({ id: 'nao-existe' }, ctx())).rejects.toThrow(/não encontrada/);
  });
});

describe('ferramentas de compromissos e lembretes', () => {
  it('cria e conclui compromisso com prazo normalizado', async () => {
    const created = await tool('create_commitment').execute(
      { description: 'Correr 5 km', due_at: '2026-10-18T07:00:00-03:00', notes: 'meta da maratona' },
      ctx(),
    );
    const c = created.output.commitment as { id: string; dueAt: string; dueAtLocal: string };
    expect(c.dueAt).toBe('2026-10-18T10:00:00.000Z');
    expect(c.dueAtLocal).toMatch(/18 de outubro de 2026/);
    const listed = await tool('list_commitments').execute({}, ctx());
    expect((listed.output.commitments as { id: string }[]).map((x) => x.id)).toContain(c.id);
    const done = await tool('update_commitment').execute({ id: c.id, status: 'done', notes: 'feito em 28 min' }, ctx());
    expect(done.output.commitment).toMatchObject({ status: 'done', notes: 'feito em 28 min' });
    await expect(tool('create_commitment').execute({ description: 'x', due_at: 'sexta' }, ctx())).rejects.toThrow(/Data inválida/);
  });

  it('cria, lista e cancela lembretes; recusa data no passado', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().replace('Z', '+00:00');
    const r = await tool('create_reminder').execute({ text: 'Pagar a fatura', due_at: future, recurrence: 'monthly' }, ctx());
    const reminder = r.output.reminder as { id: string; recurrence: string };
    expect(reminder.recurrence).toBe('monthly');
    const list = await tool('list_reminders').execute({}, ctx());
    expect(list.output.count).toBe(1);
    await expect(
      tool('create_reminder').execute({ text: 'Ontem', due_at: '2020-01-01T10:00:00-03:00' }, ctx()),
    ).rejects.toThrow(/já passou/);
    const cancelled = await tool('cancel_reminder').execute({ id: reminder.id }, ctx());
    expect(cancelled.output.reminder).toMatchObject({ status: 'cancelled' });
  });

  it('todas as ferramentas são seguras e têm rótulo em português', () => {
    expect(memoryTools.map((t) => t.name)).toEqual([
      'remember',
      'recall',
      'update_memory',
      'forget',
      'create_commitment',
      'update_commitment',
      'list_commitments',
      'create_reminder',
      'list_reminders',
      'cancel_reminder',
    ]);
    for (const t of memoryTools) {
      expect(t.risk).toBe('safe');
      expect(t.label.length).toBeGreaterThan(3);
      expect(t.parameters.type).toBe('object');
    }
  });
});

describe('busca híbrida com embeddings', () => {
  it('o worker preenche embeddings pendentes e a busca semântica acha sinônimos', async () => {
    const conv = createConversation('Pets');
    const dog = createMemory({ content: 'Lucas tem um cachorro chamado Thor', category: 'person', importance: 3 });
    addMessage({ conversationId: conv.id, role: 'user', content: 'Preciso levar meu cachorro ao veterinário semana que vem', kind: 'chat' });
    addMessage({ conversationId: conv.id, role: 'assistant', content: 'ok', kind: 'chat' });

    fake.state.enabled = true;
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const n = await runEmbeddingCycle();
      total += n;
      if (n === 0) break;
    }
    expect(total).toBeGreaterThan(0);
    expect(pending('memories')).toBe(0);
    // Mensagem curta é marcada como não indexável, não fica pendente para sempre.
    expect(pending('messages')).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE embedding_model = 'skip'").get() as { n: number }).n,
    ).toBeGreaterThan(0);

    // "cão" não aparece em nenhum texto: só a busca semântica encontra.
    const hits = await searchMemory('meu cão', { includeMessages: true });
    expect(hits.map((h) => h.id)).toContain(dog.id);
    expect(hits.some((h) => h.type === 'message' && h.content.includes('veterinário'))).toBe(true);
  });

  it('mudar o conteúdo invalida o embedding e o worker refaz', async () => {
    fake.state.enabled = true;
    const m = createMemory({ content: 'Lucas dirige um carro vermelho', category: 'fact' });
    await runEmbeddingCycle();
    expect(pending('memories')).toBe(0);
    updateMemory(m.id, { content: 'Lucas dirige um carro azul' });
    expect(pending('memories')).toBe(1);
    await runEmbeddingCycle();
    expect(pending('memories')).toBe(0);
    const hits = await searchMemory('automóvel');
    expect(hits[0]?.id).toBe(m.id);
  });

  it('reprocessa vetores gerados por outro modelo', async () => {
    fake.state.enabled = true;
    const c = createConversation('Modelo');
    const msg = addMessage({ conversationId: c.id, role: 'user', content: 'Mensagem longa o bastante para embedding', kind: 'chat' });
    await runEmbeddingCycle();
    db.prepare("UPDATE messages SET embedding_model = 'modelo-antigo' WHERE id = ?").run(msg.id);
    resetEmbeddingState();
    await runEmbeddingCycle();
    const row = db.prepare('SELECT embedding_model FROM messages WHERE id = ?').get(msg.id) as { embedding_model: string };
    expect(row.embedding_model).toBe('fake-embedding-001');
    updateMessage(msg.id, { content: 'Conteúdo novo e também longo o bastante' });
    expect((db.prepare('SELECT embedding_model FROM messages WHERE id = ?').get(msg.id) as { embedding_model: null }).embedding_model).toBeNull();
  });

  it('entra em backoff no erro 429 e a busca continua funcionando só com texto', async () => {
    fake.state.enabled = true;
    createMemory({ content: 'Reunião com a equipe Orion toda terça', category: 'work' });
    fake.state.failWith = { status: 429, message: 'RESOURCE_EXHAUSTED' };
    expect(await runEmbeddingCycle()).toBe(0);
    const callsAfterFailure = fake.state.calls;
    expect(await runEmbeddingCycle()).toBe(0); // em pausa: nem chama a API
    expect(fake.state.calls).toBe(callsAfterFailure);
    const hits = await searchMemory('orion');
    expect(hits[0]?.content).toContain('Orion');
    expect(fake.state.calls).toBe(callsAfterFailure);
  });

  it('isola e marca o item recusado (400) sem travar a fila; erro de chave só pausa', async () => {
    fake.state.enabled = true;
    createMemory({ content: 'Primeira memória processada normalmente', category: 'fact' });
    while ((await runEmbeddingCycle()) > 0); // esvazia a fila (inclui pendências de testes anteriores)
    expect(pending('memories')).toBe(0);

    const a = createMemory({ content: 'Conteúdo que a API recusa', category: 'fact' });
    const b = createMemory({ content: 'Conteúdo que a API aceita depois', category: 'fact' });
    fake.state.failWith = { status: 400, message: 'Request contains an invalid argument.' };
    await runEmbeddingCycle(); // lote de 2 falha → reduz para 1
    await runEmbeddingCycle(); // lote de 1 falha → marca o item
    fake.state.failWith = null;
    await runEmbeddingCycle();
    const model = (id: string) =>
      (db.prepare('SELECT embedding_model AS m FROM memories WHERE id = ?').get(id) as { m: string | null }).m;
    expect(model(a.id)).toBe('failed:fake-embedding-001');
    expect(model(b.id)).toBe('fake-embedding-001');

    resetEmbeddingState();
    const c = createMemory({ content: 'Memória com chave inválida configurada', category: 'fact' });
    fake.state.failWith = { status: 400, message: 'API key not valid. Please pass a valid API key.' };
    await runEmbeddingCycle();
    expect(model(c.id)).toBeNull();
    const calls = fake.state.calls;
    await runEmbeddingCycle(); // em pausa
    expect(fake.state.calls).toBe(calls);
  });

  it('dedupe semântico: sinônimo quase idêntico atualiza em vez de duplicar', async () => {
    fake.state.enabled = true;
    const remember = tool('remember');
    const a = await remember.execute({ content: 'Lucas tem um gato persa', category: 'fact' }, ctx());
    await runEmbeddingCycle();
    const b = await remember.execute({ content: 'Lucas tem um felino persa', category: 'fact' }, ctx());
    expect(a.output.action).toBe('created');
    expect(b.output.action).toBe('updated');
  });
});
