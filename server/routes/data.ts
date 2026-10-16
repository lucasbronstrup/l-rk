/**
 * Backup completo da memória do Lärk.
 *  GET  /export → JSON (anexo lark-backup-AAAA-MM-DD.json) com configurações (sem a chave da API),
 *                 conversas, mensagens, memórias, promessas e lembretes.
 *  POST /import → valida e mescla um backup: itens com id já existente são ignorados (nada é
 *                 sobrescrito); as configurações do backup são aplicadas. Embeddings são refeitos
 *                 em segundo plano pelo worker.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { MEMORY_CATEGORIES } from '../memory/memories.js';
import { COMMITMENT_STATUSES } from '../memory/commitments.js';
import { RECURRENCES, REMINDER_STATUSES } from '../memory/reminders.js';
import { SettingsValidationError, getSettings, updateSettings } from '../memory/settings.js';
import { toWallClock, safeTimeZone } from '../memory/time.js';
import { nowIso } from '../lib/ids.js';
import { describeZodError, fail, readJsonBody } from './http.js';
import type { ChatMessage, Commitment, Memory, Reminder, SettingsUpdate, ToolCallInfo } from '../../shared/types.js';

export const BACKUP_FORMAT = 'lark-backup';
export const BACKUP_VERSION = 1;
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

// ─── Exportação ──────────────────────────────────────────────────────────

interface ConversationRecord {
  id: string;
  title: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

type MemoryRecord = Memory & { archived: boolean };

export interface LarkBackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  appVersion: string;
  exportedAt: string;
  settings: Record<string, unknown>;
  conversations: ConversationRecord[];
  messages: ChatMessage[];
  memories: MemoryRecord[];
  commitments: Commitment[];
  reminders: Reminder[];
}

function parseToolCalls(raw: string | null): ToolCallInfo[] | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as ToolCallInfo[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Monta o backup completo direto do banco (inclui memórias arquivadas). */
export function buildBackup(): LarkBackupFile {
  const { hasApiKey: _omit, ...settings } = getSettings();
  void _omit;

  const conversations = (
    db.prepare('SELECT id, title, summary, created_at, updated_at FROM conversations ORDER BY created_at ASC').all() as {
      id: string;
      title: string;
      summary: string | null;
      created_at: string;
      updated_at: string;
    }[]
  ).map((r) => ({ id: r.id, title: r.title, summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at }));

  const messages = (
    db
      .prepare(
        'SELECT id, conversation_id, role, content, thoughts, tool_calls, kind, created_at FROM messages ORDER BY seq ASC',
      )
      .all() as {
      id: string;
      conversation_id: string;
      role: ChatMessage['role'];
      content: string;
      thoughts: string | null;
      tool_calls: string | null;
      kind: ChatMessage['kind'];
      created_at: string;
    }[]
  ).map((r) => {
    const message: ChatMessage = {
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      thoughts: r.thoughts,
      kind: r.kind,
      createdAt: r.created_at,
    };
    const toolCalls = parseToolCalls(r.tool_calls);
    if (toolCalls) message.toolCalls = toolCalls;
    return message;
  });

  const memories = (
    db
      .prepare(
        `SELECT id, content, category, importance, source, pinned, created_at, updated_at, last_accessed_at,
                access_count, archived FROM memories ORDER BY seq ASC`,
      )
      .all() as {
      id: string;
      content: string;
      category: Memory['category'];
      importance: number;
      source: Memory['source'];
      pinned: number;
      created_at: string;
      updated_at: string;
      last_accessed_at: string | null;
      access_count: number;
      archived: number;
    }[]
  ).map((r) => ({
    id: r.id,
    content: r.content,
    category: r.category,
    importance: r.importance,
    source: r.source,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastAccessedAt: r.last_accessed_at,
    accessCount: r.access_count,
    archived: r.archived === 1,
  }));

  const commitments = (
    db
      .prepare(
        `SELECT id, description, due_at, status, created_at, completed_at, last_checked_at, check_count, notes
         FROM commitments ORDER BY created_at ASC`,
      )
      .all() as {
      id: string;
      description: string;
      due_at: string | null;
      status: Commitment['status'];
      created_at: string;
      completed_at: string | null;
      last_checked_at: string | null;
      check_count: number;
      notes: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    description: r.description,
    dueAt: r.due_at,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    lastCheckedAt: r.last_checked_at,
    checkCount: r.check_count,
    notes: r.notes,
  }));

  const reminders = (
    db
      .prepare('SELECT id, text, due_at, recurrence, status, created_at, fired_at FROM reminders ORDER BY due_at ASC')
      .all() as {
      id: string;
      text: string;
      due_at: string;
      recurrence: Reminder['recurrence'];
      status: Reminder['status'];
      created_at: string;
      fired_at: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    text: r.text,
    dueAt: r.due_at,
    recurrence: r.recurrence,
    status: r.status,
    createdAt: r.created_at,
    firedAt: r.fired_at,
  }));

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: config.version,
    exportedAt: nowIso(),
    settings,
    conversations,
    messages,
    memories,
    commitments,
    reminders,
  };
}

// ─── Importação ──────────────────────────────────────────────────────────

const id = z.string().trim().min(1).max(200);
const iso = z
  .string()
  .max(64)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'data inválida')
  .transform((v) => new Date(v).toISOString());
const optionalIso = iso.nullish().transform((v) => v ?? null);

const conversationSchema = z.object({
  id,
  title: z.string().max(500).catch('Conversa importada'),
  summary: z.string().max(50_000).nullish().transform((v) => v ?? null),
  createdAt: iso,
  updatedAt: iso.optional(),
});

const messageSchema = z.object({
  id,
  conversationId: id,
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(1_000_000),
  thoughts: z.string().max(1_000_000).nullish(),
  toolCalls: z.array(z.unknown()).max(200).optional(),
  kind: z.enum(['chat', 'voice', 'proactive', 'briefing']).catch('chat'),
  createdAt: iso,
});

const memorySchema = z.object({
  id,
  content: z.string().trim().min(1).max(4000),
  category: z.enum(MEMORY_CATEGORIES as [Memory['category'], ...Memory['category'][]]).catch('other'),
  importance: z.number().int().min(1).max(5).catch(3),
  source: z.enum(['auto', 'tool', 'manual']).catch('manual'),
  pinned: z.boolean().catch(false),
  createdAt: iso,
  updatedAt: iso.optional(),
  lastAccessedAt: optionalIso.catch(null),
  accessCount: z.number().int().min(0).catch(0),
  archived: z.boolean().optional(),
});

const commitmentSchema = z.object({
  id,
  description: z.string().trim().min(1).max(1000),
  dueAt: optionalIso,
  status: z.enum(COMMITMENT_STATUSES as [Commitment['status'], ...Commitment['status'][]]).catch('pending'),
  createdAt: iso,
  completedAt: optionalIso.catch(null),
  lastCheckedAt: optionalIso.catch(null),
  checkCount: z.number().int().min(0).catch(0),
  notes: z.string().max(4000).nullish().transform((v) => v ?? null),
});

const reminderSchema = z.object({
  id,
  text: z.string().trim().min(1).max(1000),
  dueAt: iso,
  recurrence: z.enum(RECURRENCES as [Reminder['recurrence'], ...Reminder['recurrence'][]]).catch('none'),
  status: z.enum(REMINDER_STATUSES as [Reminder['status'], ...Reminder['status'][]]).catch('scheduled'),
  createdAt: iso,
  firedAt: optionalIso.catch(null),
});

const backupSchema = z.object({
  format: z.string().optional(),
  version: z.number().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  conversations: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  memories: z.array(z.unknown()).optional(),
  commitments: z.array(z.unknown()).optional(),
  reminders: z.array(z.unknown()).optional(),
});

/** Resultado da importação: quantidades incorporadas (chaves em PT-BR, exibidas pela interface). */
export interface ImportSummary {
  ok: true;
  imported: Record<string, number>;
  skipped: number;
  invalid: number;
  warnings: string[];
}

/** Valida item a item: inválidos são contados e descartados sem abortar o restante. */
function validItems<T extends z.ZodType>(schema: T, items: unknown[] | undefined, counter: { invalid: number }): z.infer<T>[] {
  const result: z.infer<T>[] = [];
  for (const item of items ?? []) {
    const parsed = schema.safeParse(item);
    if (parsed.success) result.push(parsed.data);
    else counter.invalid++;
  }
  return result;
}

/** Mescla um backup no banco atual. Itens com id já existente são ignorados. */
export function importBackup(raw: unknown): ImportSummary {
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) throw new ImportError(`Backup inválido — ${describeZodError(parsed.error)}`);
  const data = parsed.data;
  if (data.format !== undefined && data.format !== BACKUP_FORMAT) {
    throw new ImportError('Este arquivo não é um backup do Lärk.');
  }
  if (data.version !== undefined && data.version > BACKUP_VERSION) {
    throw new ImportError('Este backup foi gerado por uma versão mais nova do Lärk. Atualize o Lärk antes de importar.');
  }

  const counter = { invalid: 0 };
  const conversations = validItems(conversationSchema, data.conversations, counter);
  const messages = validItems(messageSchema, data.messages, counter);
  const memories = validItems(memorySchema, data.memories, counter);
  const commitments = validItems(commitmentSchema, data.commitments, counter);
  const reminders = validItems(reminderSchema, data.reminders, counter);

  const imported = { conversas: 0, mensagens: 0, 'memórias': 0, promessas: 0, lembretes: 0, 'configurações': 0 };
  let skipped = 0;
  const warnings: string[] = [];
  const now = nowIso();

  const insertConversation = db.prepare(
    'INSERT OR IGNORE INTO conversations (id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const conversationExists = db.prepare('SELECT 1 FROM conversations WHERE id = ?');
  const insertMessage = db.prepare(
    `INSERT OR IGNORE INTO messages (id, conversation_id, role, content, thoughts, tool_calls, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMemory = db.prepare(
    `INSERT OR IGNORE INTO memories (id, content, category, importance, source, pinned, created_at, updated_at,
       last_accessed_at, access_count, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCommitment = db.prepare(
    `INSERT OR IGNORE INTO commitments (id, description, due_at, status, created_at, updated_at, completed_at,
       last_checked_at, check_count, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertReminder = db.prepare(
    `INSERT OR IGNORE INTO reminders (id, text, due_at, recurrence, status, created_at, updated_at, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const touchConversation = db.prepare('UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?');

  db.transaction(() => {
    for (const conv of conversations) {
      const title = conv.title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Conversa importada';
      const changes = insertConversation.run(conv.id, title, conv.summary, conv.createdAt, conv.updatedAt ?? conv.createdAt).changes;
      if (changes) imported.conversas++;
      else skipped++;
    }
    let orphans = 0;
    for (const m of messages) {
      if (!conversationExists.get(m.conversationId)) {
        orphans++;
        continue;
      }
      const toolCalls = m.toolCalls && m.toolCalls.length ? JSON.stringify(m.toolCalls) : null;
      const changes = insertMessage.run(m.id, m.conversationId, m.role, m.content, m.thoughts ?? null, toolCalls, m.kind, m.createdAt).changes;
      if (changes) {
        imported.mensagens++;
        touchConversation.run(m.createdAt, m.conversationId);
      } else skipped++;
    }
    if (orphans) warnings.push(`${orphans} mensagem(ns) sem conversa correspondente foram ignoradas.`);
    for (const mem of memories) {
      const changes = insertMemory.run(
        mem.id,
        mem.content,
        mem.category,
        mem.importance,
        mem.source,
        mem.pinned ? 1 : 0,
        mem.createdAt,
        mem.updatedAt ?? mem.createdAt,
        mem.lastAccessedAt,
        mem.accessCount,
        mem.archived ? 1 : 0,
      ).changes;
      if (changes) imported['memórias']++;
      else skipped++;
    }
    for (const cm of commitments) {
      const changes = insertCommitment.run(
        cm.id,
        cm.description,
        cm.dueAt,
        cm.status,
        cm.createdAt,
        now,
        cm.status === 'done' ? (cm.completedAt ?? now) : null,
        cm.lastCheckedAt,
        cm.checkCount,
        cm.notes,
      ).changes;
      if (changes) imported.promessas++;
      else skipped++;
    }
    for (const r of reminders) {
      const changes = insertReminder.run(r.id, r.text, r.dueAt, r.recurrence, r.status, r.createdAt, now, r.firedAt).changes;
      if (changes) imported.lembretes++;
      else skipped++;
    }
  })();

  if (data.settings && Object.keys(data.settings).length) {
    // Nunca importa chave de API (o backup não a contém, mas um arquivo editado poderia).
    const { apiKey: _ignored, hasApiKey: _derived, ...settings } = data.settings;
    void _ignored;
    void _derived;
    try {
      updateSettings(settings as SettingsUpdate);
      imported['configurações'] = 1;
    } catch (error) {
      if (!(error instanceof SettingsValidationError)) throw error;
      warnings.push(`Configurações do backup não aplicadas: ${error.message}`);
    }
  }
  if (counter.invalid) warnings.push(`${counter.invalid} item(ns) inválido(s) foram descartados.`);

  return { ok: true, imported, skipped, invalid: counter.invalid, warnings };
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

function backupFileName(): string {
  const w = toWallClock(new Date(), safeTimeZone(getSettings().timezone));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `lark-backup-${w.year}-${pad(w.month)}-${pad(w.day)}.json`;
}

// ─── Rotas ───────────────────────────────────────────────────────────────

export const dataRoutes = new Hono();

dataRoutes.get('/export', (c) => {
  const body = JSON.stringify(buildBackup(), null, 2);
  return c.body(body, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${backupFileName()}"`,
    'Cache-Control': 'no-store',
  });
});

dataRoutes.post('/import', async (c) => {
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > MAX_IMPORT_BYTES) return fail(c, 413, 'Backup grande demais para importar de uma vez.');
  const raw = await readJsonBody(c);
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(c, 400, 'Arquivo inválido: envie o JSON de um backup do Lärk.');
  }
  try {
    return c.json(importBackup(raw));
  } catch (error) {
    if (error instanceof ImportError) return fail(c, 400, error.message);
    throw error;
  }
});
