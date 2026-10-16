/**
 * Busca híbrida da memória do Lärk.
 *
 * 1. Textual (FTS5 + bm25, ignora acentos) em memórias e, opcionalmente, em mensagens antigas.
 * 2. Semântica (cosseno entre o embedding da consulta e os vetores salvos), varrendo os vetores
 *    em memória com cache LRU — só quando há embeddings disponíveis.
 * 3. Fusão por Reciprocal Rank Fusion, com bônus de importância/recência para memórias.
 *
 * Sem chave/embeddings, funciona apenas com a busca textual.
 */
import { db } from '../db/index.js';
import { embedDetailed } from './embeddings.js';
import { MEMORY_COLUMNS, markAccessed, toMemory, type MemoryRow } from './memories.js';
import { buildFtsQuery, hasConflictingSpecifics, lexicalSimilarity, truncateText } from './text.js';
import { blobToVector, dot, vectorCache, vectorKey } from './vectors.js';
import type { Memory, MemorySearchHit, MessageRole } from '../../shared/types.js';

const RRF_K = 60;
/** Candidatos por lista antes da fusão. */
const CANDIDATES = 50;
/** Abaixo disso, a similaridade semântica é considerada ruído. */
const MIN_VECTOR_SIMILARITY = 0.5;
const MESSAGE_SNIPPET_CHARS = 600;
const DAY_MS = 86_400_000;

/** Limiares de "quase igual" usados na deduplicação. */
export const NEAR_DUPLICATE_SEMANTIC = 0.9;
export const NEAR_DUPLICATE_LEXICAL = 0.8;
const SIMILAR_SEMANTIC = 0.8;
const SIMILAR_LEXICAL = 0.5;

type ItemType = 'memory' | 'message';
interface Ranked {
  seq: number;
  /** Trecho destacado pela FTS (mensagens longas). */
  snippet?: string;
}

// ─── Busca textual ───────────────────────────────────────────────────────

const ftsMemoriesStmt = db.prepare(
  `SELECT m.seq AS seq FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
   WHERE memories_fts MATCH ? AND m.archived = 0
   ORDER BY bm25(memories_fts) LIMIT ?`,
);
const ftsMessagesStmt = db.prepare(
  `SELECT m.seq AS seq, snippet(messages_fts, 0, '', '', '…', 64) AS snippet
   FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid
   WHERE messages_fts MATCH ? AND m.role IN ('user', 'assistant') AND m.conversation_id IS NOT ?
   ORDER BY bm25(messages_fts) LIMIT ?`,
);

function ftsRank(type: ItemType, match: string, excludeConversationId: string | null): Ranked[] {
  try {
    return type === 'memory'
      ? (ftsMemoriesStmt.all(match, CANDIDATES) as Ranked[])
      : (ftsMessagesStmt.all(match, excludeConversationId, CANDIDATES) as Ranked[]);
  } catch (error) {
    console.warn('[memória] busca textual falhou:', error instanceof Error ? error.message : error);
    return [];
  }
}

// ─── Busca vetorial ──────────────────────────────────────────────────────

const vectorSeqStmts = {
  memory: db.prepare('SELECT seq FROM memories WHERE embedding_model = ? AND archived = 0'),
  message: db.prepare('SELECT seq FROM messages WHERE embedding_model = ? AND conversation_id IS NOT ?'),
};
const vectorBySeqStmts = {
  memory: db.prepare('SELECT seq, embedding FROM memories WHERE seq IN (SELECT value FROM json_each(?))'),
  message: db.prepare('SELECT seq, embedding FROM messages WHERE seq IN (SELECT value FROM json_each(?))'),
};
const vectorScanStmts = {
  memory: db.prepare('SELECT seq, embedding FROM memories WHERE embedding_model = ? AND archived = 0'),
  message: db.prepare('SELECT seq, embedding FROM messages WHERE embedding_model = ? AND conversation_id IS NOT ?'),
};

/** Vetores (do modelo indicado) dos itens elegíveis, usando o cache e buscando o que falta no banco. */
function loadVectors(type: ItemType, model: string, excludeConversationId: string | null): Map<number, Float32Array> {
  const params = type === 'memory' ? [model] : [model, excludeConversationId];
  const seqs = (vectorSeqStmts[type].all(...params) as { seq: number }[]).map((r) => r.seq);
  const out = new Map<number, Float32Array>();
  const missing: number[] = [];
  for (const seq of seqs) {
    const cached = vectorCache.get(vectorKey(model, type, seq));
    if (cached) out.set(seq, cached);
    else missing.push(seq);
  }
  if (missing.length === 0) return out;

  const ingest = (rows: Iterable<{ seq: number; embedding: Buffer | null }>, only?: Set<number>) => {
    for (const row of rows) {
      if (only && !only.has(row.seq)) continue;
      const vec = blobToVector(row.embedding);
      if (!vec) continue;
      out.set(row.seq, vec);
      vectorCache.set(vectorKey(model, type, row.seq), vec);
    }
  };

  if (missing.length > 2_000 && missing.length > seqs.length / 4) {
    // Cache frio: uma varredura sequencial é mais barata que milhares de buscas pontuais.
    ingest(vectorScanStmts[type].iterate(...params) as Iterable<{ seq: number; embedding: Buffer | null }>, new Set(missing));
  } else {
    for (let i = 0; i < missing.length; i += 500) {
      const chunk = JSON.stringify(missing.slice(i, i + 500));
      ingest(vectorBySeqStmts[type].all(chunk) as { seq: number; embedding: Buffer | null }[]);
    }
  }
  return out;
}

function vectorRank(
  type: ItemType,
  model: string,
  query: Float32Array,
  excludeConversationId: string | null,
  minSimilarity = MIN_VECTOR_SIMILARITY,
  max = CANDIDATES,
): { seq: number; similarity: number }[] {
  const scored: { seq: number; similarity: number }[] = [];
  for (const [seq, vec] of loadVectors(type, model, excludeConversationId)) {
    const similarity = dot(query, vec);
    if (similarity >= minSimilarity) scored.push({ seq, similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, max);
}

// ─── Carregamento de linhas ──────────────────────────────────────────────

const memoriesBySeqStmt = db.prepare(
  `SELECT ${MEMORY_COLUMNS} FROM memories WHERE seq IN (SELECT value FROM json_each(?))`,
);
const messagesBySeqStmt = db.prepare(
  `SELECT seq, id, conversation_id, role, content, created_at FROM messages WHERE seq IN (SELECT value FROM json_each(?))`,
);

interface MessageHitRow {
  seq: number;
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

function recency(iso: string, halfLifeDays: number): number {
  const age = Math.max(0, Date.now() - new Date(iso).getTime()) / DAY_MS;
  return Math.pow(0.5, age / halfLifeDays);
}

function memoryBoost(row: MemoryRow): number {
  const importance = (row.importance - 3) / 2; // −1 … +1
  return 1 + 0.25 * importance + 0.15 * recency(row.updated_at, 60) + (row.pinned ? 0.1 : 0);
}

function messageBoost(row: MessageHitRow): number {
  return 0.85 + 0.15 * recency(row.created_at, 30);
}

function messageContent(row: MessageHitRow, snippet: string | undefined): string {
  const speaker = row.role === 'user' ? 'Usuário' : 'Lärk';
  const text =
    row.content.length <= MESSAGE_SNIPPET_CHARS
      ? row.content.trim()
      : snippet && snippet.trim()
        ? snippet.trim()
        : truncateText(row.content, MESSAGE_SNIPPET_CHARS);
  return `${speaker}: ${text}`;
}

// ─── API pública ─────────────────────────────────────────────────────────

/**
 * Busca híbrida (textual + semântica) na memória. Com `includeMessages`, inclui trechos de
 * conversas antigas (exceto a conversa `excludeConversationId`, que já está no contexto).
 * As memórias retornadas têm `lastAccessedAt`/`accessCount` atualizados.
 */
export async function searchMemory(
  query: string,
  opts: { limit?: number; includeMessages?: boolean; excludeConversationId?: string } = {},
): Promise<MemorySearchHit[]> {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 8) || 8, 50));
  const includeMessages = Boolean(opts.includeMessages);
  const exclude = opts.excludeConversationId ?? null;
  const types: ItemType[] = includeMessages ? ['memory', 'message'] : ['memory'];

  const lists: { type: ItemType; items: Ranked[] }[] = [];
  const match = buildFtsQuery(q);
  if (match) for (const type of types) lists.push({ type, items: ftsRank(type, match, exclude) });

  const embedded = await embedDetailed([q], 'RETRIEVAL_QUERY');
  const semantic = Boolean(embedded);
  if (embedded) {
    const [vec] = embedded.vectors;
    for (const type of types) {
      try {
        lists.push({ type, items: vectorRank(type, embedded.model, vec, exclude) });
      } catch (error) {
        console.warn('[memória] busca semântica falhou:', error instanceof Error ? error.message : error);
      }
    }
  }

  // Reciprocal Rank Fusion.
  const fused = new Map<string, { type: ItemType; seq: number; rrf: number; snippet?: string }>();
  for (const { type, items } of lists) {
    items.forEach((item, rank) => {
      const key = `${type}:${item.seq}`;
      const entry = fused.get(key) ?? { type, seq: item.seq, rrf: 0 };
      entry.rrf += 1 / (RRF_K + rank + 1);
      if (item.snippet && !entry.snippet) entry.snippet = item.snippet;
      fused.set(key, entry);
    });
  }
  if (fused.size === 0) return [];

  const entries = [...fused.values()];
  const memorySeqs = entries.filter((e) => e.type === 'memory').map((e) => e.seq);
  const messageSeqs = entries.filter((e) => e.type === 'message').map((e) => e.seq);
  const memoryRows = new Map(
    (memorySeqs.length ? (memoriesBySeqStmt.all(JSON.stringify(memorySeqs)) as MemoryRow[]) : []).map((r) => [r.seq, r]),
  );
  const messageRows = new Map(
    (messageSeqs.length ? (messagesBySeqStmt.all(JSON.stringify(messageSeqs)) as MessageHitRow[]) : []).map((r) => [
      r.seq,
      r,
    ]),
  );

  // Normaliza para 0–1: o máximo teórico é ficar em 1º em todas as listas do tipo.
  const maxRrf = (semantic ? 2 : 1) / (RRF_K + 1);
  const hits: MemorySearchHit[] = [];
  for (const entry of entries) {
    if (entry.type === 'memory') {
      const row = memoryRows.get(entry.seq);
      if (!row || row.archived) continue;
      hits.push({
        type: 'memory',
        id: row.id,
        content: row.content,
        score: (entry.rrf * memoryBoost(row)) / maxRrf,
        createdAt: row.created_at,
        category: row.category,
      });
    } else {
      const row = messageRows.get(entry.seq);
      if (!row) continue;
      hits.push({
        type: 'message',
        id: row.id,
        content: messageContent(row, entry.snippet),
        score: (entry.rrf * messageBoost(row)) / maxRrf,
        createdAt: row.created_at,
        conversationId: row.conversation_id,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit).map((h) => ({ ...h, score: Math.round(Math.min(1, h.score) * 1000) / 1000 }));
  markAccessed(top.filter((h) => h.type === 'memory').map((h) => h.id));
  return top;
}

export interface SimilarMemory {
  memory: Memory;
  /** Coeficiente de Dice das palavras-chave (0–1). */
  lexical: number;
  /** Cosseno dos embeddings (0–1), ou null quando indisponível. */
  semantic: number | null;
  /** A memória existente cita nomes/números ausentes no texto novo (provavelmente outro fato). */
  conflicting: boolean;
}

/**
 * A memória existente diz praticamente a mesma coisa que o texto novo (e pode ser substituída)?
 * Nunca é duplicata quando cita nomes/números que o texto novo não menciona
 * (ex.: "irmão chamado Pedro" × "irmão chamado João").
 */
export function isNearDuplicate(hit: Pick<SimilarMemory, 'lexical' | 'semantic' | 'conflicting'>): boolean {
  if (hit.conflicting) return false;
  return hit.lexical >= NEAR_DUPLICATE_LEXICAL || (hit.semantic ?? 0) >= NEAR_DUPLICATE_SEMANTIC;
}

/** Memórias parecidas com o texto, com as medidas de similaridade (mais parecida primeiro). */
export async function findSimilarMemoriesScored(text: string, limit = 5): Promise<SimilarMemory[]> {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const bySeq = new Map<number, { lexical: number; semantic: number | null }>();

  const match = buildFtsQuery(t);
  if (match) {
    for (const { seq } of ftsRank('memory', match, null)) bySeq.set(seq, { lexical: 0, semantic: null });
  }
  const embedded = await embedDetailed([t], 'RETRIEVAL_DOCUMENT');
  if (embedded) {
    try {
      for (const { seq, similarity } of vectorRank('memory', embedded.model, embedded.vectors[0], null, SIMILAR_SEMANTIC, 20)) {
        bySeq.set(seq, { lexical: bySeq.get(seq)?.lexical ?? 0, semantic: similarity });
      }
    } catch (error) {
      console.warn('[memória] comparação semântica falhou:', error instanceof Error ? error.message : error);
    }
  }
  if (bySeq.size === 0) return [];

  const rows = memoriesBySeqStmt.all(JSON.stringify([...bySeq.keys()])) as MemoryRow[];
  const result: SimilarMemory[] = [];
  for (const row of rows) {
    if (row.archived) continue;
    const scores = bySeq.get(row.seq)!;
    const lexical = lexicalSimilarity(t, row.content);
    const semantic = scores.semantic;
    if (lexical < SIMILAR_LEXICAL && (semantic ?? 0) < SIMILAR_SEMANTIC) continue;
    result.push({ memory: toMemory(row), lexical, semantic, conflicting: hasConflictingSpecifics(row.content, t) });
  }
  const strength = (s: SimilarMemory) => Math.max(s.lexical, s.semantic ?? 0);
  result.sort((a, b) => strength(b) - strength(a));
  return result.slice(0, Math.max(1, Math.min(limit, 50)));
}

/** Memórias parecidas com o texto (para deduplicação), da mais parecida para a menos. */
export async function findSimilarMemories(text: string, limit = 5): Promise<Memory[]> {
  return (await findSimilarMemoriesScored(text, limit)).map((s) => s.memory);
}

/**
 * Núcleo da memória, sempre presente no contexto: fixadas e importância ≥ 4,
 * priorizando as mais importantes, mais acessadas e mais recentes.
 */
export function getCoreMemories(limit = 20): Memory[] {
  const n = Math.max(1, Math.min(Math.floor(limit) || 20, 200));
  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE archived = 0 AND (pinned = 1 OR importance >= 4)
       ORDER BY pinned DESC, importance DESC, access_count DESC,
                COALESCE(last_accessed_at, updated_at) DESC, seq DESC
       LIMIT ?`,
    )
    .all(n) as MemoryRow[];
  return rows.map(toMemory);
}
