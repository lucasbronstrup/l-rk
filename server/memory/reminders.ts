/**
 * Lembretes com hora marcada (e recorrência opcional).
 * Toda escrita publica `{type:'reminder'}` no bus. O disparo é feito pelo agendador (proactive).
 */
import { db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { newId, nowIso } from '../lib/ids.js';
import { addCalendarDays, daysInMonth, safeTimeZone, toWallClock, wallClockToDate, weekdayOf } from './time.js';
import type { Recurrence, Reminder, ReminderStatus } from '../../shared/types.js';

export const RECURRENCES: readonly Recurrence[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
export const REMINDER_STATUSES: readonly ReminderStatus[] = ['scheduled', 'fired', 'dismissed', 'cancelled'];

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  none: 'Uma vez',
  daily: 'Todo dia',
  weekdays: 'Dias úteis (seg–sex)',
  weekly: 'Toda semana',
  monthly: 'Todo mês',
};

interface ReminderRow {
  id: string;
  text: string;
  due_at: string;
  recurrence: Recurrence;
  status: ReminderStatus;
  created_at: string;
  fired_at: string | null;
}

const COLUMNS = 'id, text, due_at, recurrence, status, created_at, fired_at';

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    text: row.text,
    dueAt: row.due_at,
    recurrence: row.recurrence,
    status: row.status,
    createdAt: row.created_at,
    firedAt: row.fired_at,
  };
}

export function isRecurrence(value: unknown): value is Recurrence {
  return typeof value === 'string' && (RECURRENCES as readonly string[]).includes(value);
}

export function isReminderStatus(value: unknown): value is ReminderStatus {
  return typeof value === 'string' && (REMINDER_STATUSES as readonly string[]).includes(value);
}

function normalizeDate(value: string, field: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`Data inválida em "${field}": "${value}". Use ISO-8601 com fuso.`);
  }
  return date.toISOString();
}

function normalizeText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Informe o texto do lembrete.');
  if (text.length > 1000) throw new Error('Texto do lembrete longo demais (máx. 1000 caracteres).');
  return text;
}

const getStmt = db.prepare(`SELECT ${COLUMNS} FROM reminders WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO reminders (id, text, due_at, recurrence, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'scheduled', ?, ?)`,
);
const deleteStmt = db.prepare('DELETE FROM reminders WHERE id = ?');
const dueStmt = db.prepare(
  `SELECT ${COLUMNS} FROM reminders WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at ASC`,
);

export function getReminder(id: string): Reminder | null {
  const row = getStmt.get(id) as ReminderRow | undefined;
  return row ? toReminder(row) : null;
}

export function createReminder(input: { text: string; dueAt: string; recurrence?: Recurrence }): Reminder {
  const recurrence = input.recurrence ?? 'none';
  if (!isRecurrence(recurrence)) throw new Error(`Recorrência inválida: "${String(recurrence)}".`);
  const now = nowIso();
  const id = newId();
  insertStmt.run(id, normalizeText(input.text), normalizeDate(input.dueAt, 'dueAt'), recurrence, now, now);
  const reminder = getReminder(id)!;
  bus.publish({ type: 'reminder', action: 'created', reminder });
  return reminder;
}

export function updateReminder(
  id: string,
  patch: Partial<Pick<Reminder, 'text' | 'dueAt' | 'status' | 'recurrence' | 'firedAt'>>,
): Reminder | null {
  const current = getReminder(id);
  if (!current) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.text !== undefined) set('text', normalizeText(patch.text));
  if (patch.dueAt !== undefined) set('due_at', normalizeDate(patch.dueAt, 'dueAt'));
  if (patch.recurrence !== undefined) {
    if (!isRecurrence(patch.recurrence)) throw new Error(`Recorrência inválida: "${String(patch.recurrence)}".`);
    set('recurrence', patch.recurrence);
  }
  if (patch.status !== undefined) {
    if (!isReminderStatus(patch.status)) throw new Error(`Status de lembrete inválido: "${String(patch.status)}".`);
    set('status', patch.status);
  }
  if (patch.firedAt !== undefined) set('fired_at', patch.firedAt === null ? null : normalizeDate(patch.firedAt, 'firedAt'));
  if (sets.length === 0) return current;
  set('updated_at', nowIso());
  db.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  const reminder = getReminder(id)!;
  bus.publish({ type: 'reminder', action: 'updated', reminder });
  return reminder;
}

export function deleteReminder(id: string): boolean {
  const reminder = getReminder(id);
  if (!reminder) return false;
  const removed = deleteStmt.run(id).changes > 0;
  if (removed) bus.publish({ type: 'reminder', action: 'deleted', reminder });
  return removed;
}

/** Lista lembretes por ordem de horário, filtrando opcionalmente por status e intervalo [from, to]. */
export function listReminders(opts: { status?: ReminderStatus; from?: string; to?: string } = {}): Reminder[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status !== undefined) {
    if (!isReminderStatus(opts.status)) throw new Error(`Status de lembrete inválido: "${String(opts.status)}".`);
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.from) {
    where.push('due_at >= ?');
    params.push(normalizeDate(opts.from, 'from'));
  }
  if (opts.to) {
    where.push('due_at <= ?');
    params.push(normalizeDate(opts.to, 'to'));
  }
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM reminders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY due_at ASC, created_at ASC`,
    )
    .all(...params) as ReminderRow[];
  return rows.map(toReminder);
}

/** Lembretes agendados cujo horário já chegou (status 'scheduled' e dueAt ≤ now). */
export function getDueReminders(now: Date): Reminder[] {
  return (dueStmt.all(now.toISOString()) as ReminderRow[]).map(toReminder);
}

/**
 * Próxima ocorrência estritamente posterior a `dueAt`, preservando o horário de parede no fuso
 * do usuário (ex.: "todo dia às 08:00" continua às 08:00 mesmo com horário de verão).
 * - daily: dia seguinte · weekdays: próximo dia de seg a sex · weekly: +7 dias
 * - monthly: mesmo dia do mês seguinte (ajustado para o último dia quando o mês é mais curto)
 * Retorna null para 'none' ou data inválida.
 */
export function nextOccurrence(dueAt: string, recurrence: Recurrence, timezone: string): string | null {
  if (recurrence === 'none' || !isRecurrence(recurrence)) return null;
  const base = new Date(dueAt);
  if (Number.isNaN(base.getTime())) return null;
  const tz = safeTimeZone(timezone);
  const w = toWallClock(base, tz);

  let date: { year: number; month: number; day: number };
  switch (recurrence) {
    case 'daily':
      date = addCalendarDays(w.year, w.month, w.day, 1);
      break;
    case 'weekly':
      date = addCalendarDays(w.year, w.month, w.day, 7);
      break;
    case 'weekdays': {
      date = addCalendarDays(w.year, w.month, w.day, 1);
      while ([0, 6].includes(weekdayOf(date.year, date.month, date.day))) {
        date = addCalendarDays(date.year, date.month, date.day, 1);
      }
      break;
    }
    case 'monthly': {
      const year = w.month === 12 ? w.year + 1 : w.year;
      const month = w.month === 12 ? 1 : w.month + 1;
      date = { year, month, day: Math.min(w.day, daysInMonth(year, month)) };
      break;
    }
  }

  const next = wallClockToDate({ ...w, ...date }, tz);
  // Salvaguarda (transições de fuso): garante avanço estrito.
  return next.getTime() > base.getTime() ? next.toISOString() : null;
}

/**
 * Primeira ocorrência posterior a `after` (pula ocorrências perdidas, ex.: servidor desligado).
 * Útil para reagendar lembretes recorrentes após o disparo.
 */
export function nextOccurrenceAfter(dueAt: string, recurrence: Recurrence, timezone: string, after: Date): string | null {
  let current: string | null = dueAt;
  for (let i = 0; i < 2000 && current; i++) {
    current = nextOccurrence(current, recurrence, timezone);
    if (current && new Date(current).getTime() > after.getTime()) return current;
  }
  return null;
}
