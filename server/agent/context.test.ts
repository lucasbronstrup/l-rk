import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  process.env.LARK_MOCK = '1';
});

import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../memory/settings.js';
import { createConversation, updateConversation } from '../memory/conversations.js';
import { createMemory } from '../memory/memories.js';
import { createCommitment } from '../memory/commitments.js';
import { createReminder } from '../memory/reminders.js';
import { CONVERSATION_START_NOTE, buildSystemInstruction, toGeminiHistory } from './context.js';
import { VOICE_DIRECTION, buildPersona } from './persona.js';
import type { ChatMessage, Settings } from '../../shared/types.js';

let seq = 0;
function msg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  seq++;
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    role,
    content,
    kind: 'chat',
    createdAt: new Date(Date.UTC(2026, 9, 16, 12, 0, seq)).toISOString(),
    ...extra,
  };
}

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), hasApiKey: false, ...patch } as Settings;
}

describe('toGeminiHistory', () => {
  it('converte papéis e junta mensagens consecutivas do mesmo papel', () => {
    const history = toGeminiHistory([
      msg('user', 'Oi'),
      msg('user', 'Tudo bem?'),
      msg('assistant', 'Tudo ótimo.'),
      msg('user', 'Que bom'),
    ]);
    expect(history.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(history[0].parts).toEqual([{ text: 'Oi' }, { text: 'Tudo bem?' }]);
    expect(history[1].parts?.[0].text).toBe('Tudo ótimo.');
  });

  it('omite mensagens vazias e trata proativas como fala do modelo', () => {
    const history = toGeminiHistory([
      msg('user', 'Me lembra de beber água'),
      msg('assistant', '   '),
      msg('assistant', 'Hora de beber água.', { kind: 'proactive' }),
      msg('user', ''),
      msg('user', 'Feito!'),
    ]);
    expect(history.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(history[1].parts).toHaveLength(1);
    expect(history[1].parts?.[0].text).toContain('Hora de beber água.');
    expect(history[1].parts?.[0].text).toContain('iniciativa própria');
  });

  it('garante que o histórico comece pelo usuário', () => {
    const history = toGeminiHistory([msg('assistant', 'Bom dia! Seu briefing.', { kind: 'briefing' }), msg('user', 'Valeu')]);
    expect(history[0]).toEqual({ role: 'user', parts: [{ text: CONVERSATION_START_NOTE }] });
    expect(history[1].role).toBe('model');
  });

  it('registra as ferramentas usadas como nota interna', () => {
    const history = toGeminiHistory([
      msg('user', 'Anota que eu gosto de café'),
      msg('assistant', 'Anotado.', {
        toolCalls: [
          { id: 't1', name: 'remember', label: 'Guardando na memória', args: {}, status: 'done', summary: 'Guardado', risk: 'safe' },
        ],
      }),
    ]);
    const text = history[1].parts?.[0].text ?? '';
    expect(text).toMatch(/^⟦ações executadas neste turno — remember: Guardado⟧/);
    expect(text).toContain('Anotado.');
  });

  it('devolve lista vazia sem mensagens', () => {
    expect(toGeminiHistory([])).toEqual([]);
  });
});

describe('buildPersona', () => {
  it('tem identidade, oratória, reflexão e regras de memória', () => {
    const persona = buildPersona(settings(), 'text');
    expect(persona).toContain('Lärk');
    expect(persona).toContain('J.A.R.V.I.S.');
    expect(persona).toContain('SEMPRE UM PENSAMENTO');
    expect(persona).toContain('create_commitment');
    expect(persona).toContain('remember');
    expect(persona).toContain('Markdown leve');
  });

  it('modo de voz: sem markdown, sem listas, respostas curtas', () => {
    const persona = buildPersona(settings(), 'voice');
    expect(persona).toContain('MODO DE VOZ');
    expect(persona).toMatch(/sem markdown/i);
    expect(persona).toMatch(/sem listas com marcadores/i);
    expect(persona).toMatch(/de 2 a 6 frases/);
    expect(persona).not.toContain('Markdown leve');
  });

  it('usa o nome do usuário ou pede para perguntar', () => {
    expect(buildPersona(settings({ userName: 'Rafa' }), 'text')).toContain('**Rafa**');
    expect(buildPersona(settings({ userName: '' }), 'text')).toMatch(/pergunte com elegância/);
  });

  it('inclui as instruções do usuário com prioridade', () => {
    const persona = buildPersona(settings({ personaNotes: 'Fale como um pirata.' }), 'text');
    expect(persona).toContain('INSTRUÇÕES DO USUÁRIO (prioridade máxima)');
    expect(persona).toContain('Fale como um pirata.');
  });

  it('avisa quando o acesso ao computador está desligado', () => {
    const off = settings();
    off.computer = { ...off.computer, enabled: false };
    expect(buildPersona(off, 'text')).toMatch(/acesso ao computador está desativado/);
  });

  it('VOICE_DIRECTION usa o estilo das configurações', () => {
    expect(VOICE_DIRECTION({ voiceStyle: 'narrador sereno' })).toContain('narrador sereno');
    expect(VOICE_DIRECTION({ voiceStyle: '' })).toMatch(/palestrante/);
    expect(VOICE_DIRECTION({ voiceStyle: 'x' })).toMatch(/português do Brasil/);
  });
});

describe('buildSystemInstruction', () => {
  it('monta persona + agora + memórias + promessas + lembretes + resumo, com ids', async () => {
    updateSettings({ userName: 'Lucas', timezone: 'America/Sao_Paulo' });
    const conversation = createConversation('Teste');
    updateConversation(conversation.id, { summary: 'Falamos sobre a viagem a Lisboa.' });
    const core = createMemory({ content: 'Lucas toca violino na orquestra', category: 'skill', importance: 5 });
    const relevant = createMemory({ content: 'Lucas quer aprender alemão este ano', category: 'goal', importance: 3 });
    const overdue = createCommitment({ description: 'Estudar alemão', dueAt: new Date(Date.now() - 86_400_000).toISOString() });
    const soon = createReminder({ text: 'Ligar para o dentista', dueAt: new Date(Date.now() + 3_600_000).toISOString() });
    createReminder({ text: 'Lembrete distante', dueAt: new Date(Date.now() + 10 * 86_400_000).toISOString() });

    const text = await buildSystemInstruction({ conversationId: conversation.id, mode: 'text', query: 'aprender alemão' });
    expect(text).toContain('**Lucas**');
    expect(text).toContain('# AGORA');
    expect(text).toMatch(/ISO local com fuso: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    expect(text).toContain('America/Sao_Paulo');
    expect(text).toContain(`Lucas toca violino na orquestra [id: ${core.id}]`);
    expect(text).toContain('MEMÓRIAS RELEVANTES');
    expect(text).toContain(`[id: ${relevant.id}]`);
    expect(text).toContain('ATRASADA');
    expect(text).toContain(`[id: ${overdue.id}]`);
    expect(text).toContain(`Ligar para o dentista [id: ${soon.id}]`);
    expect(text).not.toContain('Lembrete distante');
    expect(text).toContain('Falamos sobre a viagem a Lisboa.');
    // A memória essencial não aparece duplicada entre as relevantes.
    expect(text.split(core.id).length - 1).toBe(1);
    expect(getSettings().userName).toBe('Lucas');
  });

  it('no modo de voz, informa o canal de voz', async () => {
    const conversation = createConversation();
    const text = await buildSystemInstruction({ conversationId: conversation.id, mode: 'voice' });
    expect(text).toContain('voz (a resposta será falada)');
    expect(text).toContain('MODO DE VOZ');
  });
});
