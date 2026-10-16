/**
 * Compromissos (promessas) que o usuário assumiu — o Lärk cobra depois se foram cumpridos.
 * Toda escrita publica `{type:'commitment'}` no bus.
 */
import { db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { newId, nowIso } from '../lib/ids.js';
import type { Commitment, CommitmentStatus } from '../../shared/types.js';

export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = ['pending', 'done', 'missed', 'cancelled'];

export const COMMITMENT_STATUS_LABELS: Record<CommitmentStatus, string> = {
  pending: 'Pendente',
  done: 'Cumprido',
  missed: 'Não cumprido',
  cancelled: 'Cancelado',
};

interface CommitmentRow {
  id: string;
  description: string;
  due_at: string | null;
  status: CommitmentStatus;
  created_at: string;
  completed_at: string | null;
  last_checked_at: string | null;
  check_count: number;
  notes: string | null;
}

const COLUMNS = 'id, description, due_at, status, created_at, completed_at, last_checked_at, check_count, notes';

function toCommitment(row: CommitmentRow): Commitment {
  return {
    id: row.id,
    description: row.description,
    dueAt: row.due_at,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    lastCheckedAt: row.last_checked_at,
    checkCount: row.check_count,
    notes: row.notes,
  };
}

export function isCommitmentStatus(value: unknown): value is CommitmentStatus {
  return typeof value === 'string' && (COMMITMENT_STATUSES as readonly string[]).includes(value);
}

/** Normaliza data opcional para ISO UTC; lança erro claro se inválida. */
function normalizeDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Data inválida em "${field}": "${value}". Use ISO-8601 com fuso.`);
  return date.toISOString();
}

function normalizeDescription(value: unknown): string {
  const description = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!description) throw new Error('Descreva o compromisso.');
  if (description.length > 1000) throw new Error('Descrição do compromisso longa demais (máx. 1000 caracteres).');
  return description;
}

function normalizeNotes(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const notes = String(value).trim();
  return notes ? notes.slice(0, 4000) : null;
}

const getStmt = db.prepare(`SELECT ${COLUMNS} FROM commitments WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO commitments (id, description, due_at, status, created_at, updated_at, notes)
   VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
);
const deleteStmt = db.prepare('DELETE FROM commitments WHERE id = ?');

export function getCommitment(id: string): Commitment | null {
  const row = getStmt.get(id) as CommitmentRow | undefined;
  return row ? toCommitment(row) : null;
}

export function createCommitment(input: { description: string; dueAt?: string | null; notes?: string | null }): Commitment {
  const now = nowIso();
  const id = newId();
  insertStmt.run(
    id,
    normalizeDescription(input.description),
    normalizeDate(input.dueAt, 'dueAt'),
    now,
    now,
    normalizeNotes(input.notes),
  );
  const commitment = getCommitment(id)!;
  bus.publish({ type: 'commitment', action: 'created', commitment });
  return commitment;
}

/**
 * Atualiza um compromisso. Ao marcar como 'done', registra `completedAt`;
 * ao voltar para 'pending', limpa `completedAt`.
 */
export function updateCommitment(
  id: string,
  patch: Partial<Pick<Commitment, 'description' | 'dueAt' | 'status' | 'notes' | 'lastCheckedAt' | 'checkCount'>>,
): Commitment | null {
  const current = getCommitment(id);
  if (!current) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.description !== undefined) set('description', normalizeDescription(patch.description));
  if (patch.dueAt !== undefined) set('due_at', normalizeDate(patch.dueAt, 'dueAt'));
  if (patch.notes !== undefined) set('notes', normalizeNotes(patch.notes));
  if (patch.lastCheckedAt !== undefined) set('last_checked_at', normalizeDate(patch.lastCheckedAt, 'lastCheckedAt'));
  if (patch.checkCount !== undefined) {
    const n = Math.floor(Number(patch.checkCount));
    if (!Number.isFinite(n) || n < 0) throw new Error('checkCount deve ser um inteiro ≥ 0.');
    set('check_count', n);
  }
  if (patch.status !== undefined) {
    if (!isCommitmentStatus(patch.status)) throw new Error(`Status de compromisso inválido: "${String(patch.status)}".`);
    set('status', patch.status);
    if (patch.status === 'done' && current.status !== 'done') set('completed_at', nowIso());
    else if (patch.status !== 'done') set('completed_at', null);
  }
  if (sets.length === 0) return current;
  set('updated_at', nowIso());
  db.prepare(`UPDATE commitments SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  const commitment = getCommitment(id)!;
  bus.publish({ type: 'commitment', action: 'updated', commitment });
  return commitment;
}

export function deleteCommitment(id: string): boolean {
  const commitment = getCommitment(id);
  if (!commitment) return false;
  const removed = deleteStmt.run(id).changes > 0;
  if (removed) bus.publish({ type: 'commitment', action: 'deleted', commitment });
  return removed;
}

/**
 * Lista compromissos. `status: 'open'` = pendentes. Pendentes vêm primeiro, pelo prazo mais próximo
 * (sem prazo por último); os demais, do mais recente para o mais antigo.
 */
export function listCommitments(opts: { status?: CommitmentStatus | 'open' } = {}): Commitment[] {
  const status = opts.status === 'open' ? 'pending' : opts.status;
  if (status !== undefined && !isCommitmentStatus(status)) {
    throw new Error(`Status de compromisso inválido: "${String(status)}".`);
  }
  const where = status ? 'WHERE status = ?' : '';
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM commitments ${where}
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                CASE WHEN status = 'pending' THEN (due_at IS NULL) ELSE 0 END,
                CASE WHEN status = 'pending' THEN due_at END ASC,
                COALESCE(completed_at, created_at) DESC`,
    )
    .all(...(status ? [status] : [])) as CommitmentRow[];
  return rows.map(toCommitment);
}
