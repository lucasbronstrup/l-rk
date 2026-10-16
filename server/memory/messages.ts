/**
 * Mensagens das conversas. Cada inserção é indexada na FTS5 (gatilhos do banco) e fica
 * pendente de embedding (`embedding_model IS NULL`) até o worker de embeddings processá-la.
 */
import { db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { newId, nowIso } from '../lib/ids.js';
import { DEFAULT_CONVERSATION_TITLE, getConversation } from './conversations.js';
import type { ChatMessage, MessageKind, MessageRole, ToolCallInfo } from '../../shared/types.js';

const ROLES: readonly MessageRole[] = ['user', 'assistant', 'system'];
const KINDS: readonly MessageKind[] = ['chat', 'voice', 'proactive', 'briefing'];
const TITLE_WORDS = 7;
const TITLE_MAX_CHARS = 60;
const DANGLING_WORDS = new Set(
  'a o as os e é de da do das dos em no na nos nas um uma para pra pro com por pelo pela que se ou ao à sem sobre'.split(' '),
);

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  thoughts: string | null;
  tool_calls: string | null;
  kind: MessageKind;
  created_at: string;
}

const COLUMNS = 'id, conversation_id, role, content, thoughts, tool_calls, kind, created_at';

const getStmt = db.prepare(`SELECT ${COLUMNS} FROM messages WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO messages (id, conversation_id, role, content, thoughts, tool_calls, kind, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const touchConversationStmt = db.prepare(
  'UPDATE conversations SET updated_at = CASE WHEN ? > updated_at THEN ? ELSE updated_at END WHERE id = ?',
);
const retitleStmt = db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title = ?');
const listLatestStmt = db.prepare(
  `SELECT ${COLUMNS} FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?`,
);
const listBeforeStmt = db.prepare(
  `SELECT ${COLUMNS} FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC, seq DESC LIMIT ?`,
);
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?');

function parseToolCalls(raw: string | null): ToolCallInfo[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ToolCallInfo[]) : [];
  } catch {
    return [];
  }
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    thoughts: row.thoughts,
    toolCalls: parseToolCalls(row.tool_calls),
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function serializeToolCalls(calls: ToolCallInfo[] | undefined): string | null {
  return calls && calls.length > 0 ? JSON.stringify(calls) : null;
}

function normalizeCreatedAt(value: string | undefined): string {
  if (!value) return nowIso();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Data de criação inválida para a mensagem: "${value}".`);
  return date.toISOString();
}

/** Título automático: primeiras palavras da primeira fala do usuário, sem marcação. */
export function titleFromText(text: string): string | null {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  const words = plain.split(' ');
  const kept = words.slice(0, TITLE_WORDS);
  let truncated = words.length > TITLE_WORDS;
  // Não termina um título truncado em preposição/artigo ("…semana de").
  while (truncated && kept.length > 2 && DANGLING_WORDS.has(kept[kept.length - 1].toLowerCase())) kept.pop();
  let title = kept.join(' ');
  if (title.length > TITLE_MAX_CHARS) {
    const cut = title.slice(0, TITLE_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    title = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
    truncated = true;
  }
  title = title.replace(/[\s,;:.!?-]+$/u, '');
  if (!title) return null;
  title = title.charAt(0).toLocaleUpperCase('pt-BR') + title.slice(1);
  return truncated ? `${title}…` : title;
}

export function getMessage(id: string): ChatMessage | null {
  const row = getStmt.get(id) as MessageRow | undefined;
  return row ? toMessage(row) : null;
}

/**
 * Registra uma mensagem, atualiza `updated_at` da conversa e, na primeira fala do usuário,
 * o título automático. Publica `{type:'conversation', action:'updated'}`.
 */
export function addMessage(
  m: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
): ChatMessage {
  if (!ROLES.includes(m.role)) throw new Error(`Papel de mensagem inválido: "${String(m.role)}".`);
  const kind: MessageKind = KINDS.includes(m.kind) ? m.kind : 'chat';
  const conversation = getConversation(m.conversationId);
  if (!conversation) throw new Error(`Conversa não encontrada: ${m.conversationId}`);

  const id = m.id || newId();
  const createdAt = normalizeCreatedAt(m.createdAt);
  const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');

  db.transaction(() => {
    insertStmt.run(
      id,
      m.conversationId,
      m.role,
      content,
      m.thoughts ?? null,
      serializeToolCalls(m.toolCalls),
      kind,
      createdAt,
    );
    touchConversationStmt.run(createdAt, createdAt, m.conversationId);
    if (m.role === 'user' && conversation.title === DEFAULT_CONVERSATION_TITLE) {
      const title = titleFromText(content);
      if (title) retitleStmt.run(title, m.conversationId, DEFAULT_CONVERSATION_TITLE);
    }
  })();

  const updated = getConversation(m.conversationId);
  if (updated) bus.publish({ type: 'conversation', action: 'updated', conversation: updated });
  return getMessage(id)!;
}

/** Atualiza conteúdo/raciocínio/ferramentas. Mudar o conteúdo invalida o embedding. */
export function updateMessage(
  id: string,
  patch: Partial<Pick<ChatMessage, 'content' | 'thoughts' | 'toolCalls'>>,
): ChatMessage | null {
  const current = getMessage(id);
  if (!current) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.content !== undefined && patch.content !== current.content) {
    sets.push('content = ?', 'embedding = NULL', 'embedding_model = NULL');
    params.push(String(patch.content));
  }
  if (patch.thoughts !== undefined) {
    sets.push('thoughts = ?');
    params.push(patch.thoughts ?? null);
  }
  if (patch.toolCalls !== undefined) {
    sets.push('tool_calls = ?');
    params.push(serializeToolCalls(patch.toolCalls));
  }
  if (sets.length === 0) return current;
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return getMessage(id);
}

/**
 * Mensagens de uma conversa em ordem cronológica. Paginação para trás:
 * `before` (createdAt ISO) devolve as `limit` mensagens imediatamente anteriores.
 */
export function listMessages(conversationId: string, opts: { limit?: number; before?: string } = {}): ChatMessage[] {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100) || 100, 1000));
  let rows: MessageRow[];
  if (opts.before) {
    const before = new Date(opts.before);
    if (Number.isNaN(before.getTime())) throw new Error(`Parâmetro "before" inválido: "${opts.before}".`);
    rows = listBeforeStmt.all(conversationId, before.toISOString(), limit) as MessageRow[];
  } else {
    rows = listLatestStmt.all(conversationId, limit) as MessageRow[];
  }
  return rows.reverse().map(toMessage);
}

export function countMessages(conversationId: string): number {
  return (countStmt.get(conversationId) as { n: number }).n;
}
