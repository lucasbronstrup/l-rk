/**
 * Memórias de longo prazo do Lärk (fatos, preferências, pessoas, metas...).
 * Toda escrita publica `{type:'memory'}` no bus. Memórias arquivadas ficam fora das listagens e buscas.
 */
import { db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { newId, nowIso } from '../lib/ids.js';
import { config } from '../config.js';
import { getApiKey } from './settings.js';
import { buildFtsQuery } from './text.js';
import type { Memory, MemoryCategory, MemoryStats } from '../../shared/types.js';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'fact',
  'preference',
  'person',
  'goal',
  'event',
  'skill',
  'health',
  'work',
  'project',
  'other',
];

/** Rótulos em PT-BR das categorias (interface e respostas das ferramentas). */
export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  fact: 'Fato',
  preference: 'Preferência',
  person: 'Pessoa',
  goal: 'Meta',
  event: 'Acontecimento',
  skill: 'Habilidade',
  health: 'Saúde',
  work: 'Trabalho',
  project: 'Projeto',
  other: 'Outro',
};

export const MAX_MEMORY_LENGTH = 4000;

export interface MemoryRow {
  seq: number;
  id: string;
  content: string;
  category: MemoryCategory;
  importance: number;
  source: Memory['source'];
  pinned: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  archived: number;
}

export const MEMORY_COLUMNS =
  'seq, id, content, category, importance, source, pinned, created_at, updated_at, last_accessed_at, access_count, archived';

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    importance: row.importance,
    source: row.source,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
  };
}

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

function normalizeCategory(value: unknown): MemoryCategory {
  return isMemoryCategory(value) ? value : 'other';
}

function normalizeImportance(value: unknown, fallback = 3): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : fallback;
}

function normalizeContent(value: unknown): string {
  const content = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!content) throw new Error('O conteúdo da memória não pode ficar vazio.');
  if (content.length > MAX_MEMORY_LENGTH) {
    throw new Error(`Memória longa demais (${content.length} caracteres; máximo ${MAX_MEMORY_LENGTH}).`);
  }
  return content;
}

const getStmt = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO memories (id, content, category, importance, source, pinned, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const deleteStmt = db.prepare('DELETE FROM memories WHERE id = ?');

export function getMemory(id: string): Memory | null {
  const row = getStmt.get(id) as MemoryRow | undefined;
  return row ? toMemory(row) : null;
}

export function createMemory(input: {
  content: string;
  category: MemoryCategory;
  importance?: number;
  source?: Memory['source'];
  pinned?: boolean;
}): Memory {
  const now = nowIso();
  const id = newId();
  const source: Memory['source'] = input.source === 'auto' || input.source === 'tool' ? input.source : 'manual';
  insertStmt.run(
    id,
    normalizeContent(input.content),
    normalizeCategory(input.category),
    normalizeImportance(input.importance),
    source,
    input.pinned ? 1 : 0,
    now,
    now,
  );
  const memory = getMemory(id)!;
  bus.publish({ type: 'memory', action: 'created', memory });
  return memory;
}

/** Atualiza campos editáveis. Mudar o conteúdo invalida o embedding (o worker refaz). */
export function updateMemory(
  id: string,
  patch: Partial<Pick<Memory, 'content' | 'category' | 'importance' | 'pinned'>>,
): Memory | null {
  const current = getMemory(id);
  if (!current) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.content !== undefined) {
    const content = normalizeContent(patch.content);
    if (content !== current.content) {
      sets.push('content = ?', 'embedding = NULL', 'embedding_model = NULL');
      params.push(content);
    }
  }
  if (patch.category !== undefined) {
    if (!isMemoryCategory(patch.category)) throw new Error(`Categoria de memória inválida: "${String(patch.category)}".`);
    sets.push('category = ?');
    params.push(patch.category);
  }
  if (patch.importance !== undefined) {
    sets.push('importance = ?');
    params.push(normalizeImportance(patch.importance, current.importance));
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(patch.pinned ? 1 : 0);
  }
  if (sets.length === 0) return current;
  sets.push('updated_at = ?');
  params.push(nowIso());
  db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  const memory = getMemory(id)!;
  bus.publish({ type: 'memory', action: 'updated', memory });
  return memory;
}

/** Arquiva (oculta sem apagar) ou restaura uma memória. */
export function setMemoryArchived(id: string, archived: boolean): Memory | null {
  const result = db
    .prepare('UPDATE memories SET archived = ?, updated_at = ? WHERE id = ?')
    .run(archived ? 1 : 0, nowIso(), id);
  if (result.changes === 0) return null;
  const memory = getMemory(id)!;
  bus.publish({ type: 'memory', action: archived ? 'deleted' : 'updated', memory });
  return memory;
}

export function deleteMemory(id: string): boolean {
  const memory = getMemory(id);
  if (!memory) return false;
  const removed = deleteStmt.run(id).changes > 0;
  if (removed) bus.publish({ type: 'memory', action: 'deleted', memory });
  return removed;
}

/**
 * Lista memórias ativas. Com `q`, usa a busca textual (FTS5, ignora acentos) ordenada por relevância;
 * sem `q`, fixadas primeiro e depois as mais recentes.
 */
export function listMemories(
  opts: { q?: string; category?: MemoryCategory; limit?: number; offset?: number } = {},
): { items: Memory[]; total: number } {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 50) || 50, 500));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0) || 0);
  const category = opts.category && isMemoryCategory(opts.category) ? opts.category : null;
  const q = opts.q?.trim();

  if (q) {
    const match = buildFtsQuery(q);
    if (!match) return { items: [], total: 0 };
    const where = `memories_fts MATCH ? AND m.archived = 0${category ? ' AND m.category = ?' : ''}`;
    const params: unknown[] = category ? [match, category] : [match];
    try {
      const total = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid WHERE ${where}`)
          .get(...params) as { n: number }
      ).n;
      const rows = db
        .prepare(
          `SELECT ${MEMORY_COLUMNS.split(', ').map((c) => `m.${c}`).join(', ')}
           FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
           WHERE ${where}
           ORDER BY bm25(memories_fts), m.pinned DESC, m.importance DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as MemoryRow[];
      return { items: rows.map(toMemory), total };
    } catch (error) {
      console.warn('[memória] busca textual falhou:', error instanceof Error ? error.message : error);
      return { items: [], total: 0 };
    }
  }

  const where = `archived = 0${category ? ' AND category = ?' : ''}`;
  const params: unknown[] = category ? [category] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${where}
       ORDER BY pinned DESC, updated_at DESC, seq DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as MemoryRow[];
  return { items: rows.map(toMemory), total };
}

/**
 * Registra que memórias foram recuperadas por uma busca (alimenta o ranking de "mais acessadas").
 * Não publica eventos (seria ruído a cada turno).
 */
export function markAccessed(ids: string[]): void {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  const now = nowIso();
  const stmt = db.prepare('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?');
  db.transaction(() => {
    for (const id of unique) stmt.run(now, id);
  })();
}

/** Embeddings só funcionam com chave real do Gemini e fora do modo demonstração. */
export function embeddingsAvailable(): boolean {
  return !config.mock && Boolean(getApiKey());
}

export function getMemoryStats(): MemoryStats {
  const byCategoryRows = db
    .prepare('SELECT category, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY category')
    .all() as { category: string; n: number }[];
  const byCategory: Record<string, number> = {};
  let memories = 0;
  for (const row of byCategoryRows) {
    byCategory[row.category] = row.n;
    memories += row.n;
  }
  const messages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const conversations = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
  const first = db
    .prepare(
      `SELECT MIN(t) AS first FROM (
         SELECT MIN(created_at) AS t FROM messages
         UNION ALL SELECT MIN(created_at) FROM memories
       )`,
    )
    .get() as { first: string | null };
  return {
    memories,
    byCategory,
    messages,
    conversations,
    firstInteractionAt: first.first ?? null,
    embeddingsEnabled: embeddingsAvailable(),
  };
}
