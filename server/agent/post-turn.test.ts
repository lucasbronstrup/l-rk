import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  delete process.env.LARK_MOCK;
  return {
    reply: '{}',
    prompts: [] as { system?: string; prompt: unknown; role?: string; json?: boolean }[],
  };
});

vi.mock('../llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/gemini.js')>();
  return {
    ...actual,
    generateText: async (opts: { system?: string; prompt: unknown; role?: string; json?: boolean }) => {
      fake.prompts.push(opts);
      return fake.reply;
    },
  };
});

import { createConversation, getConversation } from '../memory/conversations.js';
import { addMessage } from '../memory/messages.js';
import { createMemory, listMemories } from '../memory/memories.js';
import { createCommitment, getCommitment, listCommitments } from '../memory/commitments.js';
import { readSettingValue, updateSettings } from '../memory/settings.js';
import { applyExtraction, extractFromLastExchange, findLastExchange, parseExtraction, resetExtractionState } from './extract.js';
import { SUMMARY_TRIGGER_MESSAGES, maybeSummarize } from './summarize.js';
import { HISTORY_WINDOW } from './context.js';
import type { ToolCallInfo } from '../../shared/types.js';

updateSettings({ timezone: 'America/Sao_Paulo', userName: 'Lucas' });

beforeEach(() => {
  fake.reply = '{}';
  fake.prompts = [];
  resetExtractionState();
});

describe('parseExtraction', () => {
  it('aceita JSON cercado por ``` e descarta itens inválidos', () => {
    const result = parseExtraction(
      '```json\n' +
        JSON.stringify({
          memories: [
            { content: 'Lucas mora em Porto Alegre', category: 'FACT', importance: '4' },
            { content: '', category: 'fact' },
            { content: 'Lucas adora jazz', category: 'inexistente', importance: 9 },
          ],
          commitments: [{ description: 'Ligar para a avó', due_at: null }, { nada: true }],
          commitment_updates: [{ id: 'c1', status: 'done', note: 'foi ótimo' }, { id: 'c2', status: 'talvez' }],
          memory_updates: 'não é lista',
        }) +
        '\n```',
    );
    expect(result.memories).toEqual([
      { content: 'Lucas mora em Porto Alegre', category: 'fact', importance: 4 },
      { content: 'Lucas adora jazz', category: 'other', importance: 5 },
    ]);
    expect(result.commitments).toEqual([{ description: 'Ligar para a avó', due_at: null }]);
    expect(result.commitment_updates).toEqual([{ id: 'c1', status: 'done', note: 'foi ótimo' }]);
    expect(result.memory_updates).toEqual([]);
  });

  it('texto inválido vira resultado vazio', () => {
    expect(parseExtraction('desculpe, não sei')).toEqual({ memories: [], memory_updates: [], commitments: [], commitment_updates: [] });
  });
});

describe('applyExtraction', () => {
  it('cria, deduplica e respeita o que a ferramenta já registrou', async () => {
    createMemory({ content: 'Lucas tem um cachorro chamado Thor', category: 'person', importance: 3 });
    const pending = createCommitment({ description: 'Terminar o relatório trimestral' });
    const toolCalls: ToolCallInfo[] = [
      {
        id: 't1',
        name: 'remember',
        label: 'Guardando na memória',
        args: { content: 'Lucas trabalha como editor de vídeo' },
        status: 'done',
        risk: 'safe',
      },
    ];
    const summary = await applyExtraction(
      {
        memories: [
          { content: 'Lucas tem um cachorro chamado Thor', category: 'person', importance: 4 },
          { content: 'Lucas trabalha como editor de vídeo', category: 'work', importance: 4 },
          { content: 'Lucas está aprendendo piano clássico', category: 'skill', importance: 3 },
          { content: 'Detalhe trivial demais', category: 'other', importance: 1 },
        ],
        memory_updates: [{ id: 'nao-existe', content: 'qualquer coisa' }],
        commitments: [
          { description: 'Terminar o relatório trimestral', due_at: null },
          { description: 'Correr no parque', due_at: '2099-01-01' },
        ],
        commitment_updates: [{ id: pending.id, status: 'done', note: 'Entregue na sexta' }],
      },
      toolCalls,
    );
    expect(summary).toEqual({ memoriesCreated: 1, memoriesUpdated: 1, commitmentsCreated: 1, commitmentsUpdated: 1 });
    const contents = listMemories({ limit: 50 }).items.map((m) => m.content);
    expect(contents).toContain('Lucas está aprendendo piano clássico');
    expect(contents).not.toContain('Lucas trabalha como editor de vídeo');
    expect(contents.filter((c) => c.includes('Thor'))).toHaveLength(1);
    expect(listMemories({ q: 'Thor' }).items[0].importance).toBe(4);

    const done = getCommitment(pending.id)!;
    expect(done.status).toBe('done');
    expect(done.notes).toBe('Entregue na sexta');
    const run = listCommitments({ status: 'open' }).find((c) => c.description === 'Correr no parque');
    expect(run?.dueAt).toBe('2099-01-02T02:59:00.000Z');
  });
});

describe('extractFromLastExchange', () => {
  it('analisa a última troca com memórias e promessas no prompt, uma vez só', async () => {
    const conversation = createConversation();
    const commitment = createCommitment({ description: 'Ir à academia três vezes nesta semana' });
    addMessage({ conversationId: conversation.id, role: 'user', content: 'Fui à academia três vezes! E minha irmã Júlia passou na faculdade.', kind: 'chat' });
    addMessage({ conversationId: conversation.id, role: 'assistant', content: 'Que semana! Parabéns a vocês dois.', kind: 'chat' });
    fake.reply = JSON.stringify({
      memories: [{ content: 'Lucas tem uma irmã chamada Júlia, que passou na faculdade', category: 'person', importance: 4 }],
      commitment_updates: [{ id: commitment.id, status: 'done', note: 'Foi três vezes' }],
    });

    const result = await extractFromLastExchange(conversation.id);
    expect(result).toEqual({ memoriesCreated: 1, memoriesUpdated: 0, commitmentsCreated: 0, commitmentsUpdated: 1 });
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toMatchObject({ role: 'fast', json: true });
    expect(String(fake.prompts[0].prompt)).toContain(`[${commitment.id}]`);
    expect(String(fake.prompts[0].prompt)).toContain('Usuário: Fui à academia');
    expect(getCommitment(commitment.id)?.status).toBe('done');

    // A mesma troca não é analisada de novo.
    expect(await extractFromLastExchange(conversation.id)).toBeNull();
    expect(fake.prompts).toHaveLength(1);
  });

  it('ignora conversa trivial e mensagens proativas', async () => {
    const conversation = createConversation();
    addMessage({ conversationId: conversation.id, role: 'user', content: 'valeu!', kind: 'chat' });
    addMessage({ conversationId: conversation.id, role: 'assistant', content: 'Sempre às ordens.', kind: 'chat' });
    expect(await extractFromLastExchange(conversation.id)).toBeNull();
    addMessage({ conversationId: conversation.id, role: 'assistant', content: 'Lembrete: beber água.', kind: 'proactive' });
    expect(findLastExchange([])).toBeNull();
    expect(await extractFromLastExchange(conversation.id)).toBeNull();
    expect(fake.prompts).toHaveLength(0);
  });
});

describe('maybeSummarize', () => {
  it('resume as mensagens fora da janela quando a conversa passa de ~50', async () => {
    const conversation = createConversation();
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < SUMMARY_TRIGGER_MESSAGES - 1; i++) {
      addMessage({
        conversationId: conversation.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Mensagem número ${i + 1} sobre o projeto Aurora`,
        kind: 'chat',
        createdAt: new Date(base + i * 1000).toISOString(),
      });
    }
    expect(await maybeSummarize(conversation.id)).toBe(false);

    addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Mensagem número 50 sobre o projeto Aurora',
      kind: 'chat',
      createdAt: new Date(base + 60_000).toISOString(),
    });
    fake.reply = 'Contexto: o usuário está tocando o projeto Aurora.';
    expect(await maybeSummarize(conversation.id)).toBe(true);
    expect(getConversation(conversation.id)?.summary).toBe('Contexto: o usuário está tocando o projeto Aurora.');

    const prompt = String(fake.prompts[0].prompt);
    const outside = SUMMARY_TRIGGER_MESSAGES - HISTORY_WINDOW;
    expect(prompt).toContain(`Mensagem número ${outside} sobre`);
    expect(prompt).not.toContain(`Mensagem número ${outside + 1} sobre`);
    expect(readSettingValue<{ covered: number }>(`conversation_summary_state:${conversation.id}`)?.covered).toBe(outside);

    // Sem mensagens novas suficientes, não resume de novo.
    expect(await maybeSummarize(conversation.id)).toBe(false);
    expect(fake.prompts).toHaveLength(1);
  });
});
