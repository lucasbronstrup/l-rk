/**
 * Ferramentas de memória do Lärk (todas 'safe'): lembrar, recordar, corrigir, esquecer,
 * registrar e cobrar compromissos do usuário e gerenciar lembretes com hora marcada.
 */
import { z } from 'zod';
import { getSettings } from '../memory/settings.js';
import {
  MEMORY_CATEGORIES,
  createMemory,
  deleteMemory,
  getMemory,
  isMemoryCategory,
  updateMemory,
} from '../memory/memories.js';
import { findSimilarMemoriesScored, isNearDuplicate, searchMemory } from '../memory/search.js';
import {
  COMMITMENT_STATUSES,
  COMMITMENT_STATUS_LABELS,
  createCommitment,
  getCommitment,
  listCommitments,
  updateCommitment,
} from '../memory/commitments.js';
import { RECURRENCES, RECURRENCE_LABELS, createReminder, getReminder, listReminders, updateReminder } from '../memory/reminders.js';
import { formatLocalDateTime, parseOptionalUserDate, parseUserDate } from '../memory/time.js';
import { truncateText } from '../memory/text.js';
import type { Commitment, Memory, MemoryCategory, Reminder } from '../../shared/types.js';
import type { ToolDefinition } from './types.js';

// ─── Utilidades ──────────────────────────────────────────────────────────

/** Valida os argumentos vindos do modelo, com erro claro em PT-BR. */
function parseArgs<T extends z.ZodType>(tool: string, schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'argumentos'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Argumentos inválidos para ${tool} — ${details}`);
}

const timeZone = () => getSettings().timezone;
const quote = (text: string, max = 80) => `“${truncateText(text, max)}”`;
const localTime = (iso: string | null) => (iso ? formatLocalDateTime(iso, timeZone()) : null);

const id = z.string({ error: 'informe o id' }).trim().min(1, 'informe o id');
const optionalText = z.string().trim().nullish();
const category = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isMemoryCategory, { message: `categoria deve ser uma de: ${MEMORY_CATEGORIES.join(', ')}` });
const importance = z.coerce
  .number({ error: 'importância deve ser um número de 1 a 5' })
  .min(1, 'importância mínima é 1')
  .max(5, 'importância máxima é 5')
  .transform((n) => Math.round(n));

function memoryOutput(m: Memory) {
  return {
    id: m.id,
    content: m.content,
    category: m.category,
    importance: m.importance,
    pinned: m.pinned,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function commitmentOutput(c: Commitment) {
  const overdue = c.status === 'pending' && c.dueAt !== null && new Date(c.dueAt).getTime() < Date.now();
  return {
    id: c.id,
    description: c.description,
    status: c.status,
    statusLabel: COMMITMENT_STATUS_LABELS[c.status],
    dueAt: c.dueAt,
    dueAtLocal: localTime(c.dueAt),
    overdue,
    notes: c.notes,
    createdAt: c.createdAt,
    completedAt: c.completedAt,
    timesCheckedOn: c.checkCount,
  };
}

function reminderOutput(r: Reminder) {
  return {
    id: r.id,
    text: r.text,
    dueAt: r.dueAt,
    dueAtLocal: localTime(r.dueAt),
    recurrence: r.recurrence,
    recurrenceLabel: RECURRENCE_LABELS[r.recurrence],
    status: r.status,
  };
}

const DATE_HINT =
  'Data/hora ISO-8601 com fuso, ex.: "2026-10-17T09:00:00-03:00". Calcule a partir da data/hora atual informada no contexto.';

// ─── Memórias ────────────────────────────────────────────────────────────

const remember: ToolDefinition = {
  name: 'remember',
  label: 'Guardando na memória',
  risk: 'safe',
  description:
    'Guarda na memória permanente um fato relevante sobre o usuário ou sobre a vida dele (preferências, pessoas, ' +
    'metas, saúde, trabalho, projetos, acontecimentos, habilidades). Use sempre que ele revelar algo que valha ' +
    'lembrar no futuro, mesmo sem pedir. Escreva uma frase autocontida, em português, em terceira pessoa ' +
    '(ex.: "Lucas prefere café sem açúcar"). Se já existir uma memória quase igual, ela é atualizada em vez de duplicada.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'O fato a lembrar, numa frase clara e autocontida.' },
      category: {
        type: 'string',
        enum: [...MEMORY_CATEGORIES],
        description:
          'fact=fato geral, preference=gosto/preferência, person=pessoa da vida do usuário, goal=meta/sonho, ' +
          'event=acontecimento, skill=habilidade, health=saúde, work=trabalho, project=projeto, other=outro.',
      },
      importance: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: '1 = trivial … 5 = essencial (identidade, saúde, pessoas próximas, metas de vida). Padrão 3.',
      },
    },
    required: ['content', 'category'],
  },
  describe: (args) => `Lembrar: ${String(args.content ?? '')}`,
  async execute(args) {
    const a = parseArgs(
      'remember',
      z.object({
        content: z.string({ error: 'informe o conteúdo' }).trim().min(1, 'informe o conteúdo'),
        category: category.optional(),
        importance: importance.nullish(),
      }),
      args,
    );
    const cat = (a.category ?? 'other') as MemoryCategory;
    const duplicate = (await findSimilarMemoriesScored(a.content, 5)).find(isNearDuplicate);
    if (duplicate) {
      const previous = duplicate.memory;
      const memory = updateMemory(previous.id, {
        content: a.content,
        category: cat,
        importance: Math.max(previous.importance, a.importance ?? previous.importance),
      })!;
      return {
        output: { ok: true, action: 'updated', previousContent: previous.content, memory: memoryOutput(memory) },
        summary: `Memória atualizada: ${quote(memory.content)}`,
      };
    }
    const memory = createMemory({ content: a.content, category: cat, importance: a.importance ?? 3, source: 'tool' });
    return {
      output: { ok: true, action: 'created', memory: memoryOutput(memory) },
      summary: `Guardado na memória: ${quote(memory.content)}`,
    };
  },
};

const recall: ToolDefinition = {
  name: 'recall',
  label: 'Consultando a memória',
  risk: 'safe',
  description:
    'Busca na memória permanente e em TODAS as conversas anteriores (busca híbrida textual + semântica). ' +
    'Use quando o assunto puder depender de algo que o usuário já contou, quando ele perguntar "você lembra…?", ' +
    'ou para recuperar detalhes de conversas passadas. Retorna memórias (fatos) e trechos de mensagens antigas.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'O que procurar (palavras-chave ou uma pergunta em linguagem natural).' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Máximo de resultados (padrão 8).' },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'recall',
      z.object({
        query: z.string({ error: 'informe a busca' }).trim().min(1, 'informe a busca'),
        limit: z.coerce.number().min(1).max(20).transform(Math.round).nullish(),
      }),
      args,
    );
    const hits = await searchMemory(a.query, {
      limit: a.limit ?? 8,
      includeMessages: true,
      excludeConversationId: ctx.conversationId,
    });
    const memories = hits.filter((h) => h.type === 'memory').length;
    const excerpts = hits.length - memories;
    return {
      output: {
        query: a.query,
        count: hits.length,
        results: hits.map((h) => ({
          type: h.type === 'memory' ? 'memória' : 'trecho de conversa',
          id: h.id,
          content: h.content,
          category: h.category,
          when: localTime(h.createdAt),
          relevance: h.score,
        })),
        ...(hits.length === 0 ? { note: 'Nada encontrado sobre isso na memória.' } : {}),
      },
      summary:
        hits.length === 0
          ? 'Nada encontrado na memória'
          : `${memories} ${memories === 1 ? 'memória' : 'memórias'} e ${excerpts} ${excerpts === 1 ? 'trecho' : 'trechos'} de conversas`,
    };
  },
};

const updateMemoryTool: ToolDefinition = {
  name: 'update_memory',
  label: 'Atualizando memória',
  risk: 'safe',
  description:
    'Corrige ou complementa uma memória existente (use o id retornado por recall). ' +
    'Use quando o usuário corrigir uma informação ou quando um fato mudar.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id da memória.' },
      content: { type: 'string', description: 'Novo texto completo da memória.' },
      importance: { type: 'integer', minimum: 1, maximum: 5, description: 'Nova importância (1–5).' },
      category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: 'Nova categoria.' },
    },
    required: ['id'],
  },
  async execute(args) {
    const a = parseArgs(
      'update_memory',
      z.object({ id, content: optionalText, importance: importance.nullish(), category: category.nullish() }),
      args,
    );
    if (!getMemory(a.id)) throw new Error(`Memória não encontrada (id ${a.id}). Use recall para achar o id correto.`);
    const memory = updateMemory(a.id, {
      ...(a.content ? { content: a.content } : {}),
      ...(a.importance ? { importance: a.importance } : {}),
      ...(a.category ? { category: a.category as MemoryCategory } : {}),
    })!;
    return {
      output: { ok: true, memory: memoryOutput(memory) },
      summary: `Memória atualizada: ${quote(memory.content)}`,
    };
  },
};

const forget: ToolDefinition = {
  name: 'forget',
  label: 'Esquecendo memória',
  risk: 'safe',
  description:
    'Apaga definitivamente uma memória (use o id retornado por recall). ' +
    'Use quando o usuário pedir para esquecer algo ou quando a informação estiver errada e não houver correção.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Id da memória a apagar.' } },
    required: ['id'],
  },
  async execute(args) {
    const a = parseArgs('forget', z.object({ id }), args);
    const memory = getMemory(a.id);
    if (!memory || !deleteMemory(a.id)) {
      throw new Error(`Memória não encontrada (id ${a.id}). Use recall para achar o id correto.`);
    }
    return {
      output: { ok: true, forgotten: memory.content },
      summary: `Memória apagada: ${quote(memory.content)}`,
    };
  },
};

// ─── Compromissos (promessas do usuário) ─────────────────────────────────

const createCommitmentTool: ToolDefinition = {
  name: 'create_commitment',
  label: 'Registrando compromisso',
  risk: 'safe',
  description:
    'Registra uma promessa/compromisso que o USUÁRIO assumiu consigo mesmo ou com alguém ' +
    '(ex.: "vou à academia amanhã cedo", "termino o relatório até sexta", "vou ligar para minha mãe"). ' +
    'O Lärk vai cobrar depois se foi cumprido. Registre sempre que o usuário disser que vai fazer algo. ' +
    'Não use para tarefas do próprio Lärk; para um aviso em hora marcada use create_reminder.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'O que o usuário prometeu fazer, numa frase clara.' },
      due_at: { type: 'string', description: `Prazo (opcional). ${DATE_HINT} Só a data = até 23:59 daquele dia.` },
      notes: { type: 'string', description: 'Contexto útil para a cobrança (motivação, para quem, por quê).' },
    },
    required: ['description'],
  },
  async execute(args) {
    const a = parseArgs(
      'create_commitment',
      z.object({
        description: z.string({ error: 'descreva o compromisso' }).trim().min(1, 'descreva o compromisso'),
        due_at: optionalText,
        notes: optionalText,
      }),
      args,
    );
    const dueAt = parseOptionalUserDate(a.due_at, { timeZone: timeZone(), dateOnlyTime: '23:59' });
    const commitment = createCommitment({ description: a.description, dueAt, notes: a.notes ?? null });
    const when = commitment.dueAt ? ` (prazo: ${localTime(commitment.dueAt)})` : '';
    return {
      output: { ok: true, commitment: commitmentOutput(commitment) },
      summary: `Compromisso registrado: ${quote(commitment.description)}${when}`,
    };
  },
};

const updateCommitmentTool: ToolDefinition = {
  name: 'update_commitment',
  label: 'Atualizando compromisso',
  risk: 'safe',
  description:
    'Atualiza um compromisso do usuário: marque "done" quando ele contar que cumpriu, "missed" quando não cumpriu, ' +
    '"cancelled" se desistiu, ou "pending" para reabrir. Pode também adiar o prazo (due_at) e registrar observações.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id do compromisso (veja list_commitments).' },
      status: { type: 'string', enum: [...COMMITMENT_STATUSES], description: 'Novo status.' },
      notes: { type: 'string', description: 'Observações (ex.: como foi, por que não deu).' },
      due_at: { type: 'string', description: `Novo prazo (opcional). ${DATE_HINT}` },
    },
    required: ['id'],
  },
  async execute(args) {
    const a = parseArgs(
      'update_commitment',
      z.object({
        id,
        status: z.enum([...COMMITMENT_STATUSES] as [string, ...string[]]).nullish(),
        notes: optionalText,
        due_at: optionalText,
      }),
      args,
    );
    const current = getCommitment(a.id);
    if (!current) throw new Error(`Compromisso não encontrado (id ${a.id}). Use list_commitments para ver os ids.`);
    const dueAt = a.due_at ? parseUserDate(a.due_at, { timeZone: timeZone(), dateOnlyTime: '23:59' }) : undefined;
    const commitment = updateCommitment(a.id, {
      ...(a.status ? { status: a.status as Commitment['status'] } : {}),
      ...(a.notes ? { notes: a.notes } : {}),
      ...(dueAt ? { dueAt } : {}),
    })!;
    return {
      output: { ok: true, commitment: commitmentOutput(commitment) },
      summary: `Compromisso ${COMMITMENT_STATUS_LABELS[commitment.status].toLowerCase()}: ${quote(commitment.description)}`,
    };
  },
};

const listCommitmentsTool: ToolDefinition = {
  name: 'list_commitments',
  label: 'Revisando compromissos',
  risk: 'safe',
  description:
    'Lista os compromissos/promessas do usuário. Por padrão, só os em aberto (pendentes), com prazo e se estão atrasados.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['open', ...COMMITMENT_STATUSES, 'all'],
        description: 'open (padrão) = pendentes; all = todos.',
      },
    },
  },
  async execute(args) {
    const a = parseArgs(
      'list_commitments',
      z.object({ status: z.enum(['open', 'all', ...COMMITMENT_STATUSES] as [string, ...string[]]).nullish() }),
      args,
    );
    const status = a.status ?? 'open';
    const items = listCommitments(status === 'all' ? {} : { status: status as Commitment['status'] | 'open' });
    const overdue = items.filter((c) => commitmentOutput(c).overdue).length;
    return {
      output: { count: items.length, overdue, commitments: items.slice(0, 50).map(commitmentOutput) },
      summary:
        items.length === 0
          ? 'Nenhum compromisso encontrado'
          : `${items.length} ${items.length === 1 ? 'compromisso' : 'compromissos'}${overdue ? ` (${overdue} atrasado${overdue > 1 ? 's' : ''})` : ''}`,
    };
  },
};

// ─── Lembretes ───────────────────────────────────────────────────────────

const createReminderTool: ToolDefinition = {
  name: 'create_reminder',
  label: 'Criando lembrete',
  risk: 'safe',
  description:
    'Agenda um lembrete: no horário marcado o Lärk avisa o usuário proativamente (por texto e voz). ' +
    'Use para "me lembra de…", "me avisa às…". Suporta recorrência.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'O que lembrar, escrito para ser dito ao usuário no momento do aviso.' },
      due_at: { type: 'string', description: `Quando avisar. ${DATE_HINT}` },
      recurrence: {
        type: 'string',
        enum: [...RECURRENCES],
        description: 'none (padrão), daily = todo dia, weekdays = seg a sex, weekly = toda semana, monthly = todo mês.',
      },
    },
    required: ['text', 'due_at'],
  },
  async execute(args) {
    const a = parseArgs(
      'create_reminder',
      z.object({
        text: z.string({ error: 'informe o texto do lembrete' }).trim().min(1, 'informe o texto do lembrete'),
        due_at: z.string({ error: 'informe a data/hora (due_at)' }).trim().min(1, 'informe a data/hora (due_at)'),
        recurrence: z.enum([...RECURRENCES] as [string, ...string[]]).nullish(),
      }),
      args,
    );
    const tz = timeZone();
    const dueAt = parseUserDate(a.due_at, { timeZone: tz, dateOnlyTime: '09:00' });
    if (new Date(dueAt).getTime() < Date.now() - 60_000) {
      throw new Error(
        `O horário ${formatLocalDateTime(dueAt, tz)} já passou (agora: ${formatLocalDateTime(new Date().toISOString(), tz)}, ` +
          `fuso ${tz}). Informe uma data futura.`,
      );
    }
    const reminder = createReminder({
      text: a.text,
      dueAt,
      recurrence: (a.recurrence ?? 'none') as Reminder['recurrence'],
    });
    const repeat = reminder.recurrence !== 'none' ? `, ${RECURRENCE_LABELS[reminder.recurrence].toLowerCase()}` : '';
    return {
      output: { ok: true, reminder: reminderOutput(reminder) },
      summary: `Lembrete para ${localTime(reminder.dueAt)}${repeat}: ${quote(reminder.text, 60)}`,
    };
  },
};

const listRemindersTool: ToolDefinition = {
  name: 'list_reminders',
  label: 'Consultando lembretes',
  risk: 'safe',
  description: 'Lista os lembretes agendados (ainda não disparados), do mais próximo ao mais distante.',
  parameters: { type: 'object', properties: {} },
  async execute() {
    const items = listReminders({ status: 'scheduled' });
    return {
      output: { count: items.length, reminders: items.slice(0, 50).map(reminderOutput) },
      summary:
        items.length === 0
          ? 'Nenhum lembrete agendado'
          : `${items.length} ${items.length === 1 ? 'lembrete agendado' : 'lembretes agendados'}`,
    };
  },
};

const cancelReminderTool: ToolDefinition = {
  name: 'cancel_reminder',
  label: 'Cancelando lembrete',
  risk: 'safe',
  description: 'Cancela um lembrete agendado (use o id de list_reminders).',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Id do lembrete.' } },
    required: ['id'],
  },
  async execute(args) {
    const a = parseArgs('cancel_reminder', z.object({ id }), args);
    const current = getReminder(a.id);
    if (!current) throw new Error(`Lembrete não encontrado (id ${a.id}). Use list_reminders para ver os ids.`);
    if (current.status === 'cancelled') {
      return { output: { ok: true, alreadyCancelled: true, reminder: reminderOutput(current) }, summary: 'Lembrete já estava cancelado' };
    }
    const reminder = updateReminder(a.id, { status: 'cancelled' })!;
    return {
      output: { ok: true, reminder: reminderOutput(reminder) },
      summary: `Lembrete cancelado: ${quote(reminder.text, 60)}`,
    };
  },
};

export const memoryTools: ToolDefinition[] = [
  remember,
  recall,
  updateMemoryTool,
  forget,
  createCommitmentTool,
  updateCommitmentTool,
  listCommitmentsTool,
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
];
