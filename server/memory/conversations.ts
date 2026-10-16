/**
 * Conversas: criação, listagem, renomeação, resumo e exclusão (mensagens em cascata).
 * Toda escrita publica `{type:'conversation'}` no bus.
 */
import { db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { newId, nowIso } from '../lib/ids.js';
import type { Conversation } from '../../shared/types.js';

export const DEFAULT_CONVERSATION_TITLE = 'Nova conversa';
const MAX_TITLE = 120;

interface ConversationRow {
  id: string;
  title: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

const SELECT_COLUMNS = `
  c.id, c.title, c.summary, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count`;

const getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM conversations c WHERE c.id = ?`);
const listStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM conversations c ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`);
const latestStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM conversations c ORDER BY c.updated_at DESC, c.created_at DESC LIMIT 1`);
const insertStmt = db.prepare('INSERT INTO conversations (id, title, summary, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)');
const deleteStmt = db.prepare('DELETE FROM conversations WHERE id = ?');

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: row.summary,
    messageCount: row.message_count,
  };
}

/** Limpa um título (uma linha, sem espaços extras, tamanho máximo). */
export function cleanTitle(title: string | null | undefined): string {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_TITLE) : DEFAULT_CONVERSATION_TITLE;
}

export function createConversation(title?: string): Conversation {
  const now = nowIso();
  const id = newId();
  insertStmt.run(id, cleanTitle(title), now, now);
  const conversation = getConversation(id)!;
  bus.publish({ type: 'conversation', action: 'created', conversation });
  return conversation;
}

export function getConversation(id: string): Conversation | null {
  const row = getStmt.get(id) as ConversationRow | undefined;
  return row ? toConversation(row) : null;
}

export function listConversations(limit = 50): Conversation[] {
  const n = Math.max(1, Math.min(Math.floor(limit) || 50, 1000));
  return (listStmt.all(n) as ConversationRow[]).map(toConversation);
}

export function updateConversation(id: string, patch: { title?: string; summary?: string | null }): Conversation | null {
  const current = getConversation(id);
  if (!current) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(cleanTitle(patch.title));
  }
  if (patch.summary !== undefined) {
    sets.push('summary = ?');
    params.push(patch.summary === null ? null : String(patch.summary).trim() || null);
  }
  if (sets.length === 0) return current;
  // Renomear/resumir não altera updated_at: a ordem da lista reflete a última mensagem.
  db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  const conversation = getConversation(id)!;
  bus.publish({ type: 'conversation', action: 'updated', conversation });
  return conversation;
}

export function deleteConversation(id: string): boolean {
  const conversation = getConversation(id);
  if (!conversation) return false;
  const removed = deleteStmt.run(id).changes > 0;
  if (removed) bus.publish({ type: 'conversation', action: 'deleted', conversation });
  return removed;
}

/** A conversa atualizada mais recentemente; cria uma nova se não houver nenhuma. */
export function getOrCreateActiveConversation(): Conversation {
  const row = latestStmt.get() as ConversationRow | undefined;
  return row ? toConversation(row) : createConversation();
}
