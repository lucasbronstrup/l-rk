/**
 * Ferramentas locais do Lärk na edição web (todas 'safe'): memória, promessas, lembretes e data/hora.
 * Mesmos nomes e semântica de server/tools/memory-tools.ts, usadas tanto pelo Gemini quanto pelo Claude.
 */
import type { Commitment, Memory, MemoryCategory, Reminder, ToolCallInfo } from '@shared/types';
import {
  COMMITMENT_STATUSES,
  COMMITMENT_STATUS_LABELS,
  MEMORY_CATEGORIES,
  RECURRENCES,
  RECURRENCE_LABELS,
  createCommitment,
  createMemory,
  createReminder,
  deleteMemory,
  findNearDuplicate,
  getCommitment,
  getMemory,
  getReminder,
  getSettings,
  isCommitmentStatus,
  isMemoryCategory,
  isRecurrence,
  listCommitments,
  listReminders,
  searchMemory,
  updateCommitment,
  updateMemory,
  updateReminder,
} from './db';
import { formatLocalDateTime, offsetLabel, parseOptionalUserDate, parseUserDate, safeTimeZone, toLocalIso } from './time';
import { newId, truncate } from './util';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolResult {
  output: Record<string, unknown>;
  summary: string;
}

export interface LocalTool {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  execute(args: Record<string, unknown>, ctx: { conversationId: string }): Promise<ToolResult> | ToolResult;
}

const tz = () => safeTimeZone(getSettings().timezone);
const quote = (text: string, max = 80) => `“${truncate(text, max)}”`;
const localTime = (iso: string | null) => (iso ? formatLocalDateTime(iso, tz()) : null);

const DATE_HINT =
  'Data/hora ISO-8601 com fuso, ex.: "2026-10-17T09:00:00-03:00". Calcule a partir da data/hora atual informada no contexto (ou use get_datetime).';

function text(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function requireText(args: Record<string, unknown>, key: string, message: string): string {
  const v = text(args, key);
  if (!v) throw new Error(message);
  return v;
}

function memoryOutput(m: Memory) {
  return { id: m.id, content: m.content, category: m.category, importance: m.importance, pinned: m.pinned };
}

function commitmentOutput(c: Commitment) {
  const overdue = c.status === 'pending' && c.dueAt !== null && new Date(c.dueAt).getTime() < Date.now();
  return {
    id: c.id,
    description: c.description,
    status: c.status,
    statusLabel: COMMITMENT_STATUS_LABELS[c.status],
    dueAtLocal: localTime(c.dueAt),
    overdue,
    notes: c.notes,
    timesCheckedOn: c.checkCount,
  };
}

function reminderOutput(r: Reminder) {
  return {
    id: r.id,
    text: r.text,
    dueAtLocal: localTime(r.dueAt),
    recurrence: r.recurrence,
    recurrenceLabel: RECURRENCE_LABELS[r.recurrence],
    status: r.status,
  };
}

// ─── Definições ──────────────────────────────────────────────────────────

const remember: LocalTool = {
  name: 'remember',
  label: 'Guardando na memória',
  description:
    'Guarda na memória permanente um fato relevante sobre o usuário ou sobre a vida dele (preferências, pessoas, metas, saúde, ' +
    'trabalho, projetos, acontecimentos, habilidades). Use sempre que ele revelar algo que valha lembrar, mesmo sem pedir. ' +
    'Escreva uma frase autocontida em terceira pessoa (ex.: "Lucas prefere café sem açúcar"). Memórias quase iguais são atualizadas.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'O fato a lembrar, numa frase clara e autocontida.' },
      category: {
        type: 'string',
        enum: [...MEMORY_CATEGORIES],
        description: 'fact, preference, person, goal, event, skill, health, work, project ou other.',
      },
      importance: { type: 'integer', minimum: 1, maximum: 5, description: '1 = trivial … 5 = essencial. Padrão 3.' },
    },
    required: ['content', 'category'],
  },
  execute(args) {
    const content = requireText(args, 'content', 'Informe o conteúdo da memória (content).');
    const category: MemoryCategory = isMemoryCategory(text(args, 'category').toLowerCase()) ? (text(args, 'category').toLowerCase() as MemoryCategory) : 'other';
    const importance = args.importance === undefined ? undefined : Number(args.importance);
    const dup = findNearDuplicate(content);
    if (dup) {
      const memory = updateMemory(dup.id, {
        content,
        category,
        importance: Math.max(dup.importance, Number.isFinite(importance) ? Math.round(importance!) : dup.importance),
      })!;
      return { output: { ok: true, action: 'updated', previousContent: dup.content, memory: memoryOutput(memory) }, summary: `Memória atualizada: ${quote(memory.content)}` };
    }
    const memory = createMemory({ content, category, importance: importance ?? 3, source: 'tool' });
    return { output: { ok: true, action: 'created', memory: memoryOutput(memory) }, summary: `Guardado na memória: ${quote(memory.content)}` };
  },
};

const recall: LocalTool = {
  name: 'recall',
  label: 'Consultando a memória',
  description:
    'Busca na memória permanente e em conversas anteriores (busca por palavras, sem acentos). Use quando o assunto puder depender ' +
    'de algo que o usuário já contou ou quando ele perguntar "você lembra…?". Retorna memórias (com id) e trechos de mensagens.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Palavras-chave do que procurar.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Máximo de resultados (padrão 8).' },
    },
    required: ['query'],
  },
  execute(args, ctx) {
    const query = requireText(args, 'query', 'Informe o que buscar (query).');
    const limit = Math.min(20, Math.max(1, Math.round(Number(args.limit) || 8)));
    const hits = searchMemory(query, { limit, includeMessages: true, excludeConversationId: ctx.conversationId });
    const memories = hits.filter((h) => h.type === 'memory').length;
    const excerpts = hits.length - memories;
    return {
      output: {
        query,
        count: hits.length,
        results: hits.map((h) => ({
          type: h.type === 'memory' ? 'memória' : 'trecho de conversa',
          id: h.id,
          content: h.content,
          category: h.category,
          when: localTime(h.createdAt),
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

const forget: LocalTool = {
  name: 'forget',
  label: 'Esquecendo memória',
  description: 'Apaga definitivamente uma memória (use o id retornado por recall). Use quando o usuário pedir para esquecer algo.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'Id da memória a apagar.' } }, required: ['id'] },
  execute(args) {
    const id = requireText(args, 'id', 'Informe o id da memória.');
    const memory = getMemory(id);
    if (!memory || !deleteMemory(id)) throw new Error(`Memória não encontrada (id ${id}). Use recall para achar o id correto.`);
    return { output: { ok: true, forgotten: memory.content }, summary: `Memória apagada: ${quote(memory.content)}` };
  },
};

const createCommitmentTool: LocalTool = {
  name: 'create_commitment',
  label: 'Registrando compromisso',
  description:
    'Registra uma promessa/compromisso que o USUÁRIO assumiu (ex.: "vou à academia amanhã cedo", "termino o relatório até sexta"). ' +
    'O Lärk cobra depois se foi cumprido. Registre sempre que o usuário disser que vai fazer algo. Para avisos em hora marcada use create_reminder.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'O que o usuário prometeu fazer, numa frase clara.' },
      due_at: { type: 'string', description: `Prazo (opcional). ${DATE_HINT} Só a data = até 23:59 daquele dia.` },
      notes: { type: 'string', description: 'Contexto útil para a cobrança (motivação, para quem, por quê).' },
    },
    required: ['description'],
  },
  execute(args) {
    const description = requireText(args, 'description', 'Descreva o compromisso (description).');
    const dueAt = parseOptionalUserDate(text(args, 'due_at') || null, { timeZone: tz(), dateOnlyTime: '23:59' });
    const c = createCommitment({ description, dueAt, notes: text(args, 'notes') || null });
    const when = c.dueAt ? ` (prazo: ${localTime(c.dueAt)})` : '';
    return { output: { ok: true, commitment: commitmentOutput(c) }, summary: `Compromisso registrado: ${quote(c.description)}${when}` };
  },
};

const updateCommitmentTool: LocalTool = {
  name: 'update_commitment',
  label: 'Atualizando compromisso',
  description:
    'Atualiza um compromisso: "done" quando o usuário cumpriu, "missed" quando não cumpriu, "cancelled" se desistiu, "pending" para reabrir. ' +
    'Também adia o prazo (due_at) e registra observações (notes). Use o id de list_commitments.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id do compromisso.' },
      status: { type: 'string', enum: [...COMMITMENT_STATUSES], description: 'Novo status.' },
      notes: { type: 'string', description: 'Observações (como foi, por que não deu).' },
      due_at: { type: 'string', description: `Novo prazo (opcional). ${DATE_HINT}` },
    },
    required: ['id'],
  },
  execute(args) {
    const id = requireText(args, 'id', 'Informe o id do compromisso.');
    if (!getCommitment(id)) throw new Error(`Compromisso não encontrado (id ${id}). Use list_commitments para ver os ids.`);
    const status = text(args, 'status');
    if (status && !isCommitmentStatus(status)) throw new Error(`Status inválido: ${status}. Use pending, done, missed ou cancelled.`);
    const due = text(args, 'due_at');
    const dueAt = due ? parseUserDate(due, { timeZone: tz(), dateOnlyTime: '23:59' }) : undefined;
    const c = updateCommitment(id, {
      ...(status ? { status } : {}),
      ...(text(args, 'notes') ? { notes: text(args, 'notes') } : {}),
      ...(dueAt ? { dueAt } : {}),
    })!;
    return { output: { ok: true, commitment: commitmentOutput(c) }, summary: `Compromisso ${COMMITMENT_STATUS_LABELS[c.status].toLowerCase()}: ${quote(c.description)}` };
  },
};

const listCommitmentsTool: LocalTool = {
  name: 'list_commitments',
  label: 'Revisando compromissos',
  description: 'Lista os compromissos/promessas do usuário. Por padrão só os em aberto, com prazo e se estão atrasados.',
  parameters: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['open', ...COMMITMENT_STATUSES, 'all'], description: 'open (padrão) = pendentes; all = todos.' } },
  },
  execute(args) {
    const status = text(args, 'status') || 'open';
    const items = listCommitments(status === 'all' ? {} : { status });
    const overdue = items.filter((c) => commitmentOutput(c).overdue).length;
    return {
      output: { count: items.length, overdue, commitments: items.slice(0, 30).map(commitmentOutput) },
      summary:
        items.length === 0
          ? 'Nenhum compromisso encontrado'
          : `${items.length} ${items.length === 1 ? 'compromisso' : 'compromissos'}${overdue ? ` (${overdue} atrasado${overdue > 1 ? 's' : ''})` : ''}`,
    };
  },
};

const createReminderTool: LocalTool = {
  name: 'create_reminder',
  label: 'Criando lembrete',
  description:
    'Agenda um lembrete: no horário marcado o Lärk avisa o usuário (texto e voz) enquanto esta página estiver aberta. ' +
    'Use para "me lembra de…", "me avisa às…". Suporta recorrência.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'O que lembrar, escrito para ser dito ao usuário no momento do aviso.' },
      due_at: { type: 'string', description: `Quando avisar. ${DATE_HINT}` },
      recurrence: { type: 'string', enum: [...RECURRENCES], description: 'none (padrão), daily, weekdays (seg–sex), weekly ou monthly.' },
    },
    required: ['text', 'due_at'],
  },
  execute(args) {
    const reminderText = requireText(args, 'text', 'Informe o texto do lembrete (text).');
    const due = requireText(args, 'due_at', 'Informe a data/hora do lembrete (due_at).');
    const zone = tz();
    const dueAt = parseUserDate(due, { timeZone: zone, dateOnlyTime: '09:00' });
    if (new Date(dueAt).getTime() < Date.now() - 60_000) {
      throw new Error(
        `O horário ${formatLocalDateTime(dueAt, zone)} já passou (agora: ${formatLocalDateTime(new Date().toISOString(), zone)}, fuso ${zone}). Informe uma data futura.`,
      );
    }
    const recurrence = isRecurrence(text(args, 'recurrence')) ? (text(args, 'recurrence') as Reminder['recurrence']) : 'none';
    const r = createReminder({ text: reminderText, dueAt, recurrence });
    const repeat = r.recurrence !== 'none' ? `, ${RECURRENCE_LABELS[r.recurrence].toLowerCase()}` : '';
    return { output: { ok: true, reminder: reminderOutput(r) }, summary: `Lembrete para ${localTime(r.dueAt)}${repeat}: ${quote(r.text, 60)}` };
  },
};

const listRemindersTool: LocalTool = {
  name: 'list_reminders',
  label: 'Consultando lembretes',
  description: 'Lista os lembretes agendados (ainda não disparados), do mais próximo ao mais distante, com ids.',
  parameters: { type: 'object', properties: {} },
  execute() {
    const items = listReminders({ status: 'scheduled' });
    return {
      output: { count: items.length, reminders: items.slice(0, 30).map(reminderOutput) },
      summary: items.length === 0 ? 'Nenhum lembrete agendado' : `${items.length} ${items.length === 1 ? 'lembrete agendado' : 'lembretes agendados'}`,
    };
  },
};

const cancelReminderTool: LocalTool = {
  name: 'cancel_reminder',
  label: 'Cancelando lembrete',
  description: 'Cancela um lembrete agendado (use o id de list_reminders).',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'Id do lembrete.' } }, required: ['id'] },
  execute(args) {
    const id = requireText(args, 'id', 'Informe o id do lembrete.');
    const cur = getReminder(id);
    if (!cur) throw new Error(`Lembrete não encontrado (id ${id}). Use list_reminders para ver os ids.`);
    if (cur.status === 'cancelled') return { output: { ok: true, alreadyCancelled: true }, summary: 'Lembrete já estava cancelado' };
    const r = updateReminder(id, { status: 'cancelled' })!;
    return { output: { ok: true, reminder: reminderOutput(r) }, summary: `Lembrete cancelado: ${quote(r.text, 60)}` };
  },
};

const getDatetime: LocalTool = {
  name: 'get_datetime',
  label: 'Consultando o relógio',
  description: 'Informa a data e a hora atuais no fuso do usuário (ISO com offset, dia da semana e por extenso). Use antes de calcular prazos.',
  parameters: { type: 'object', properties: {} },
  execute() {
    const zone = tz();
    const now = new Date();
    return {
      output: {
        nowLocalIso: toLocalIso(now, zone),
        nowUtc: now.toISOString(),
        timezone: zone,
        utcOffset: offsetLabel(now, zone),
        weekday: new Intl.DateTimeFormat('pt-BR', { timeZone: zone, weekday: 'long' }).format(now),
        human: formatLocalDateTime(now.toISOString(), zone),
      },
      summary: formatLocalDateTime(now.toISOString(), zone),
    };
  },
};

export const LOCAL_TOOLS: LocalTool[] = [
  remember,
  recall,
  forget,
  createCommitmentTool,
  updateCommitmentTool,
  listCommitmentsTool,
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
  getDatetime,
];

const byName = new Map(LOCAL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): LocalTool | undefined {
  return byName.get(name);
}

/**
 * Executa uma ferramenta, avisando a interface (running → done/error) por `emit`.
 * Nunca lança: erros viram `{ ok: false, error }` para o modelo corrigir o rumo.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { conversationId: string; emit: (call: ToolCallInfo) => void },
): Promise<{ call: ToolCallInfo; output: Record<string, unknown>; ok: boolean }> {
  const tool = getTool(name);
  const call: ToolCallInfo = {
    id: newId(),
    name,
    label: tool?.label ?? name,
    args,
    status: 'running',
    risk: 'safe',
  };
  ctx.emit({ ...call });
  if (!tool) {
    const error = /computer|file|shell|screen|arquivo|terminal/i.test(name)
      ? 'Ferramenta indisponível: a edição web não tem acesso ao computador.'
      : `Ferramenta desconhecida: ${name}.`;
    const done: ToolCallInfo = { ...call, status: 'error', summary: error };
    ctx.emit(done);
    return { call: done, output: { ok: false, error }, ok: false };
  }
  try {
    const result = await tool.execute(args ?? {}, { conversationId: ctx.conversationId });
    const done: ToolCallInfo = { ...call, status: 'done', summary: result.summary };
    ctx.emit(done);
    return { call: done, output: result.output, ok: true };
  } catch (e) {
    const error = e instanceof Error && e.message ? e.message : 'Falha ao executar a ferramenta.';
    const failed: ToolCallInfo = { ...call, status: 'error', summary: truncate(error, 200) };
    ctx.emit(failed);
    return { call: failed, output: { ok: false, error }, ok: false };
  }
}
