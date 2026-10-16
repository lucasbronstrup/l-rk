/**
 * Camada de dados da edição web (equivalente a server/memory/*): configurações, conversas,
 * mensagens, memórias, promessas e lembretes, com publicação de eventos no barramento local.
 */
import type {
  ChatMessage,
  Commitment,
  CommitmentStatus,
  Conversation,
  Memory,
  MemoryCategory,
  MemorySearchHit,
  MemoryStats,
  ModelRole,
  Recurrence,
  Reminder,
  ReminderStatus,
  Settings,
} from '@shared/types';
import { bus } from './bus';
import { kv, readValue, tables, writeValue } from './storage';
import { lexicalSimilarity, matchScore, normalizeText, queryTerms } from './text';
import { deviceTimeZone, isValidTimeZone } from './time';
import { HttpError, badRequest, isRecord, newId, nowIso, truncate } from './util';

// ─── Configurações ───────────────────────────────────────────────────────

type StoredSettings = Omit<Settings, 'hasApiKey'>;

export const DEFAULT_VOICE_STYLE =
  'Palestrante carismático e experiente: voz grave, calorosa e confiante, ritmo envolvente, pausas de efeito antes das ideias centrais';

function defaultSettings(): StoredSettings {
  return {
    userName: '',
    personaNotes: '',
    timezone: deviceTimeZone(),
    models: { chat: '', fast: '', tts: '', live: '', embedding: '' },
    voiceName: 'Charon',
    voiceStyle: DEFAULT_VOICE_STYLE,
    speakInChat: false,
    showThoughts: true,
    computer: { enabled: false, approvalMode: 'ask', favoritePaths: [] },
    proactive: {
      enabled: true,
      checkInEveryHours: 6,
      quietHoursStart: '23:00',
      quietHoursEnd: '07:00',
      morningBriefing: true,
    },
  };
}

export const COMPUTER_UNAVAILABLE =
  'Edição web: acesso ao computador indisponível. Para ler arquivos, abrir aplicativos e vigiar a máquina, instale o Lärk no seu computador.';

const MODEL_ROLES: ModelRole[] = ['chat', 'fast', 'tts', 'live', 'embedding'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function loadStored(): StoredSettings {
  const base = defaultSettings();
  const raw = readValue<unknown>('settings');
  if (!isRecord(raw)) return base;
  // Mescla tolerante: campos inválidos voltam ao padrão.
  const s: StoredSettings = { ...base };
  if (typeof raw.userName === 'string') s.userName = raw.userName.slice(0, 80);
  if (typeof raw.personaNotes === 'string') s.personaNotes = raw.personaNotes.slice(0, 4000);
  if (typeof raw.timezone === 'string' && isValidTimeZone(raw.timezone)) s.timezone = raw.timezone;
  if (isRecord(raw.models)) {
    for (const role of MODEL_ROLES) {
      const v = raw.models[role];
      if (typeof v === 'string') s.models[role] = v;
    }
  }
  if (typeof raw.voiceName === 'string' && raw.voiceName.trim()) s.voiceName = raw.voiceName.trim();
  if (typeof raw.voiceStyle === 'string') s.voiceStyle = raw.voiceStyle;
  if (typeof raw.speakInChat === 'boolean') s.speakInChat = raw.speakInChat;
  if (typeof raw.showThoughts === 'boolean') s.showThoughts = raw.showThoughts;
  if (isRecord(raw.computer)) {
    const c = raw.computer;
    if (c.approvalMode === 'ask' || c.approvalMode === 'dangerous-only' || c.approvalMode === 'never') s.computer.approvalMode = c.approvalMode;
    if (Array.isArray(c.favoritePaths)) s.computer.favoritePaths = c.favoritePaths.filter((p): p is string => typeof p === 'string');
  }
  if (isRecord(raw.proactive)) {
    const p = raw.proactive;
    if (typeof p.enabled === 'boolean') s.proactive.enabled = p.enabled;
    if (typeof p.checkInEveryHours === 'number' && p.checkInEveryHours >= 0.25 && p.checkInEveryHours <= 720) s.proactive.checkInEveryHours = p.checkInEveryHours;
    if (typeof p.quietHoursStart === 'string' && HHMM.test(p.quietHoursStart)) s.proactive.quietHoursStart = p.quietHoursStart;
    if (typeof p.quietHoursEnd === 'string' && HHMM.test(p.quietHoursEnd)) s.proactive.quietHoursEnd = p.quietHoursEnd;
    if (typeof p.morningBriefing === 'boolean') s.proactive.morningBriefing = p.morningBriefing;
  }
  // Edição web: nunca há acesso ao computador.
  s.computer.enabled = false;
  return s;
}

export function getApiKey(): string {
  const k = readValue<unknown>('apiKey');
  return typeof k === 'string' ? k.trim() : '';
}

export function getSettings(): Settings {
  return { ...structuredClone(loadStored()), hasApiKey: Boolean(getApiKey()) };
}

const keyListeners = new Set<() => void>();
/** Avisa quando a chave da API muda (o cérebro reavalia o motor). */
export function onApiKeyChange(fn: () => void): () => void {
  keyListeners.add(fn);
  return () => keyListeners.delete(fn);
}

/** PUT /api/settings — merge profundo com validação; erros viram 400 com mensagem em PT-BR. */
export function updateSettings(patch: unknown): Settings {
  if (!isRecord(patch)) throw badRequest('Configurações inválidas — envie um objeto JSON.');
  const next = loadStored();
  const problems: string[] = [];
  const fail = (label: string, msg: string) => problems.push(`${label}: ${msg}`);

  if (patch.userName !== undefined) {
    if (typeof patch.userName !== 'string' || patch.userName.trim().length > 80) fail('nome', 'texto de até 80 caracteres');
    else next.userName = patch.userName.trim();
  }
  if (patch.personaNotes !== undefined) {
    if (typeof patch.personaNotes !== 'string' || patch.personaNotes.length > 4000) fail('notas de personalidade', 'até 4000 caracteres');
    else next.personaNotes = patch.personaNotes;
  }
  if (patch.timezone !== undefined) {
    if (typeof patch.timezone !== 'string' || !isValidTimeZone(patch.timezone.trim())) fail('fuso horário', 'fuso IANA inválido (ex.: America/Sao_Paulo)');
    else next.timezone = patch.timezone.trim();
  }
  if (patch.models !== undefined) {
    if (!isRecord(patch.models)) fail('modelos', 'tipo de valor inválido');
    else {
      for (const [role, value] of Object.entries(patch.models)) {
        if (!MODEL_ROLES.includes(role as ModelRole)) continue;
        if (typeof value !== 'string' || value.length > 200) fail('modelos', `valor inválido para ${role}`);
        else next.models[role as ModelRole] = value.trim();
      }
    }
  }
  if (patch.voiceName !== undefined) {
    if (typeof patch.voiceName !== 'string' || !patch.voiceName.trim() || patch.voiceName.length > 64) fail('voz', 'escolha uma voz');
    else next.voiceName = patch.voiceName.trim();
  }
  if (patch.voiceStyle !== undefined) {
    if (typeof patch.voiceStyle !== 'string' || patch.voiceStyle.length > 1000) fail('estilo de voz', 'até 1000 caracteres');
    else next.voiceStyle = patch.voiceStyle.trim();
  }
  for (const key of ['speakInChat', 'showThoughts'] as const) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') fail(key === 'speakInChat' ? 'responder com voz no chat' : 'mostrar raciocínio', 'tipo de valor inválido');
    else next[key] = patch[key];
  }
  if (patch.computer !== undefined) {
    const c = patch.computer;
    if (!isRecord(c)) fail('acesso ao computador', 'tipo de valor inválido');
    else {
      if (c.enabled === true) throw new HttpError(400, COMPUTER_UNAVAILABLE);
      if (c.approvalMode !== undefined) {
        if (c.approvalMode !== 'ask' && c.approvalMode !== 'dangerous-only' && c.approvalMode !== 'never') fail('modo de aprovação', 'valor inválido');
        else next.computer.approvalMode = c.approvalMode;
      }
      if (c.favoritePaths !== undefined) {
        if (!Array.isArray(c.favoritePaths) || c.favoritePaths.some((p) => typeof p !== 'string')) fail('pastas favoritas', 'lista inválida');
        else next.computer.favoritePaths = (c.favoritePaths as string[]).map((p) => p.trim()).filter(Boolean).slice(0, 100);
      }
    }
  }
  if (patch.proactive !== undefined) {
    const p = patch.proactive;
    if (!isRecord(p)) fail('proatividade', 'tipo de valor inválido');
    else {
      for (const key of ['enabled', 'morningBriefing'] as const) {
        if (p[key] === undefined) continue;
        if (typeof p[key] !== 'boolean') fail(key === 'enabled' ? 'proatividade' : 'briefing matinal', 'tipo de valor inválido');
        else next.proactive[key] = p[key];
      }
      if (p.checkInEveryHours !== undefined) {
        const n = Number(p.checkInEveryHours);
        if (!Number.isFinite(n) || n < 0.25 || n > 720) fail('intervalo de cobranças', 'entre 0,25 e 720 horas');
        else next.proactive.checkInEveryHours = n;
      }
      for (const key of ['quietHoursStart', 'quietHoursEnd'] as const) {
        if (p[key] === undefined) continue;
        const v = p[key];
        if (typeof v !== 'string' || !HHMM.test(v.trim())) fail(key === 'quietHoursStart' ? 'início do silêncio' : 'fim do silêncio', 'use o formato HH:MM (ex.: 23:00)');
        else next.proactive[key] = v.trim();
      }
    }
  }
  let keyChanged = false;
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== 'string' || patch.apiKey.length > 512) fail('chave de API', 'texto de até 512 caracteres');
    else keyChanged = true;
  }
  if (problems.length) throw badRequest(`Configurações inválidas — ${problems.join('; ')}.`);

  next.computer.enabled = false;
  writeValue('settings', next);
  if (keyChanged) {
    const key = (patch.apiKey as string).trim();
    writeValue('apiKey', key || null);
    keyListeners.forEach((fn) => fn());
  }
  const settings = getSettings();
  bus.publish({ type: 'settings', settings });
  return settings;
}

// ─── Conversas ───────────────────────────────────────────────────────────

const DEFAULT_TITLE = 'Nova conversa';

function publishConversation(action: 'created' | 'updated' | 'deleted', conversation: Conversation) {
  bus.publish({ type: 'conversation', action, conversation });
}

export function createConversation(title?: string): Conversation {
  const now = nowIso();
  const conv: Conversation = {
    id: newId(),
    title: title?.trim() ? truncate(title, 80) : DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
    summary: null,
    messageCount: 0,
  };
  tables.conversations.put(conv);
  publishConversation('created', conv);
  return conv;
}

export function getConversation(id: string): Conversation | null {
  return tables.conversations.get(id);
}

export function listConversations(limit?: number): Conversation[] {
  const list = tables.conversations.all().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return typeof limit === 'number' && limit > 0 ? list.slice(0, limit) : list;
}

export function updateConversation(id: string, patch: { title?: string; summary?: string | null }): Conversation | null {
  const cur = tables.conversations.get(id);
  if (!cur) return null;
  const next: Conversation = {
    ...cur,
    ...(typeof patch.title === 'string' && patch.title.trim() ? { title: truncate(patch.title, 80) } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    updatedAt: nowIso(),
  };
  tables.conversations.put(next);
  publishConversation('updated', next);
  return next;
}

export function deleteConversation(id: string): boolean {
  const cur = tables.conversations.get(id);
  if (!cur) return false;
  tables.messages.deleteWhere((m) => m.conversationId === id);
  tables.conversations.delete(id);
  publishConversation('deleted', cur);
  return true;
}

export function getOrCreateActiveConversation(): Conversation {
  return listConversations(1)[0] ?? createConversation();
}

// ─── Mensagens ───────────────────────────────────────────────────────────

export function addMessage(m: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): ChatMessage {
  const msg: ChatMessage = {
    id: m.id ?? newId(),
    createdAt: m.createdAt ?? nowIso(),
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    kind: m.kind,
    ...(m.thoughts !== undefined ? { thoughts: m.thoughts } : {}),
    ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls } : {}),
  };
  tables.messages.put(msg);
  if (!kv.get<string>('firstInteractionAt')) kv.set('firstInteractionAt', msg.createdAt);
  const conv = tables.conversations.get(msg.conversationId);
  if (conv) {
    const title =
      conv.title === DEFAULT_TITLE && msg.role === 'user' && msg.content.trim() ? truncate(msg.content, 48) : conv.title;
    const next: Conversation = { ...conv, title, updatedAt: msg.createdAt, messageCount: countMessages(conv.id) };
    tables.conversations.put(next);
    publishConversation('updated', next);
  }
  return msg;
}

export function updateMessage(id: string, patch: Partial<Pick<ChatMessage, 'content' | 'thoughts' | 'toolCalls'>>): ChatMessage | null {
  const cur = tables.messages.get(id);
  if (!cur) return null;
  return tables.messages.put({ ...cur, ...patch });
}

export function deleteMessage(id: string): void {
  const cur = tables.messages.get(id);
  if (!cur) return;
  tables.messages.delete(id);
  const conv = tables.conversations.get(cur.conversationId);
  if (conv) tables.conversations.put({ ...conv, messageCount: countMessages(conv.id) });
}

function byCreated(a: ChatMessage, b: ChatMessage): number {
  const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (t !== 0) return t;
  if (a.role !== b.role) return a.role === 'user' ? -1 : 1;
  return 0;
}

export function listMessages(conversationId: string, opts: { limit?: number; before?: string } = {}): ChatMessage[] {
  let list = tables.messages.all().filter((m) => m.conversationId === conversationId);
  if (opts.before) {
    const limit = Date.parse(opts.before);
    if (Number.isFinite(limit)) list = list.filter((m) => Date.parse(m.createdAt) < limit);
  }
  list.sort(byCreated);
  const n = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 500) : list.length;
  return list.slice(Math.max(0, list.length - n));
}

export function countMessages(conversationId?: string): number {
  if (!conversationId) return tables.messages.size;
  return tables.messages.all().filter((m) => m.conversationId === conversationId).length;
}

// ─── Memórias ────────────────────────────────────────────────────────────

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

export function isMemoryCategory(v: unknown): v is MemoryCategory {
  return typeof v === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(v);
}

const clampImportance = (n: unknown, fallback = 3) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : fallback;
};

export function createMemory(input: {
  content: string;
  category?: unknown;
  importance?: unknown;
  source?: Memory['source'];
  pinned?: boolean;
}): Memory {
  const content = String(input.content ?? '').trim();
  if (!content) throw badRequest('Escreva o conteúdo da memória.');
  if (content.length > 2000) throw badRequest('Memória longa demais (máx. 2000 caracteres).');
  const now = nowIso();
  const memory: Memory = {
    id: newId(),
    content,
    category: isMemoryCategory(input.category) ? input.category : 'other',
    importance: clampImportance(input.importance),
    source: input.source ?? 'manual',
    pinned: Boolean(input.pinned),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    accessCount: 0,
  };
  tables.memories.put(memory);
  bus.publish({ type: 'memory', action: 'created', memory });
  return memory;
}

export function getMemory(id: string): Memory | null {
  return tables.memories.get(id);
}

export function updateMemory(id: string, patch: Partial<Pick<Memory, 'content' | 'category' | 'importance' | 'pinned'>>): Memory | null {
  const cur = tables.memories.get(id);
  if (!cur) return null;
  const next: Memory = { ...cur, updatedAt: nowIso() };
  if (typeof patch.content === 'string') {
    const c = patch.content.trim();
    if (!c) throw badRequest('A memória não pode ficar vazia.');
    next.content = c.slice(0, 2000);
  }
  if (patch.category !== undefined) {
    if (!isMemoryCategory(patch.category)) throw badRequest('Categoria de memória inválida.');
    next.category = patch.category;
  }
  if (patch.importance !== undefined) next.importance = clampImportance(patch.importance, cur.importance);
  if (patch.pinned !== undefined) next.pinned = Boolean(patch.pinned);
  tables.memories.put(next);
  bus.publish({ type: 'memory', action: 'updated', memory: next });
  return next;
}

export function deleteMemory(id: string): boolean {
  const cur = tables.memories.get(id);
  if (!cur) return false;
  tables.memories.delete(id);
  bus.publish({ type: 'memory', action: 'deleted', memory: cur });
  return true;
}

function memoryRank(m: Memory): number {
  return (m.pinned ? 10 : 0) + m.importance;
}

export function listMemories(opts: { q?: string; category?: string | null; limit?: number; offset?: number } = {}): { items: Memory[]; total: number } {
  let list = tables.memories.all();
  if (opts.category && isMemoryCategory(opts.category)) list = list.filter((m) => m.category === opts.category);
  const q = opts.q?.trim();
  if (q) {
    const terms = queryTerms(q);
    const needle = normalizeText(q);
    const scored = list
      .map((m) => ({ m, s: Math.max(matchScore(terms, m.content), normalizeText(m.content).includes(needle) ? 1 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || memoryRank(b.m) - memoryRank(a.m) || Date.parse(b.m.updatedAt) - Date.parse(a.m.updatedAt));
    list = scored.map((x) => x.m);
  } else {
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 40;
  return { items: list.slice(offset, offset + limit), total: list.length };
}

/** Busca textual (sem acentos) em memórias e, opcionalmente, mensagens antigas. */
export function searchMemory(query: string, opts: { limit?: number; includeMessages?: boolean; excludeConversationId?: string } = {}): MemorySearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: MemorySearchHit[] = [];
  for (const m of tables.memories.all()) {
    const s = matchScore(terms, m.content);
    if (s > 0) {
      hits.push({ type: 'memory', id: m.id, content: m.content, score: Math.min(1, s * 0.85 + m.importance * 0.03), createdAt: m.createdAt, category: m.category });
    }
  }
  if (opts.includeMessages) {
    for (const msg of tables.messages.all()) {
      if (msg.conversationId === opts.excludeConversationId || msg.role === 'system' || !msg.content) continue;
      const s = matchScore(terms, msg.content);
      if (s >= 0.5) {
        hits.push({
          type: 'message',
          id: msg.id,
          content: truncate(`${msg.role === 'user' ? 'Usuário' : 'Lärk'}: ${msg.content}`, 400),
          score: s * 0.7,
          createdAt: msg.createdAt,
          conversationId: msg.conversationId,
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const out = hits.slice(0, opts.limit ?? 10);
  // Marca acesso às memórias encontradas (sem publicar evento: é só estatística).
  const now = nowIso();
  for (const h of out) {
    if (h.type !== 'memory') continue;
    const m = tables.memories.get(h.id);
    if (m) tables.memories.put({ ...m, lastAccessedAt: now, accessCount: m.accessCount + 1 });
  }
  return out;
}

/** Memória quase igual (para atualizar em vez de duplicar). */
export function findNearDuplicate(content: string): Memory | null {
  let best: { m: Memory; s: number } | null = null;
  for (const m of tables.memories.all()) {
    const s = lexicalSimilarity(content, m.content);
    if (s >= 0.8 && (!best || s > best.s)) best = { m, s };
  }
  return best?.m ?? null;
}

/** Memórias sempre presentes no contexto: fixadas e mais importantes. */
export function getCoreMemories(limit = 12): Memory[] {
  return tables.memories
    .all()
    .filter((m) => m.pinned || m.importance >= 4)
    .sort((a, b) => memoryRank(b) - memoryRank(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

export function getMemoryStats(): MemoryStats {
  const byCategory: Record<string, number> = {};
  for (const m of tables.memories.all()) byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
  return {
    memories: tables.memories.size,
    byCategory,
    messages: tables.messages.size,
    conversations: tables.conversations.size,
    firstInteractionAt: kv.get<string>('firstInteractionAt') ?? null,
    embeddingsEnabled: false,
  };
}

// ─── Promessas ───────────────────────────────────────────────────────────

export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = ['pending', 'done', 'missed', 'cancelled'];
export const COMMITMENT_STATUS_LABELS: Record<CommitmentStatus, string> = {
  pending: 'Pendente',
  done: 'Cumprido',
  missed: 'Não cumprido',
  cancelled: 'Cancelado',
};

export function isCommitmentStatus(v: unknown): v is CommitmentStatus {
  return typeof v === 'string' && (COMMITMENT_STATUSES as readonly string[]).includes(v);
}

function normalizeOptionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw badRequest(`Data inválida em "${field}". Use ISO-8601 com fuso.`);
  return d.toISOString();
}

export function createCommitment(input: { description: unknown; dueAt?: unknown; notes?: unknown }): Commitment {
  const description = String(input.description ?? '').trim();
  if (!description) throw badRequest('Descreva a promessa.');
  const c: Commitment = {
    id: newId(),
    description: description.slice(0, 500),
    dueAt: normalizeOptionalDate(input.dueAt, 'dueAt'),
    status: 'pending',
    createdAt: nowIso(),
    completedAt: null,
    lastCheckedAt: null,
    checkCount: 0,
    notes: typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 1000) : null,
  };
  tables.commitments.put(c);
  bus.publish({ type: 'commitment', action: 'created', commitment: c });
  return c;
}

export function getCommitment(id: string): Commitment | null {
  return tables.commitments.get(id);
}

export function updateCommitment(id: string, patch: Record<string, unknown>): Commitment | null {
  const cur = tables.commitments.get(id);
  if (!cur) return null;
  const next: Commitment = { ...cur };
  if (patch.description !== undefined) {
    const d = String(patch.description ?? '').trim();
    if (!d) throw badRequest('A promessa não pode ficar vazia.');
    next.description = d.slice(0, 500);
  }
  if (patch.dueAt !== undefined) next.dueAt = normalizeOptionalDate(patch.dueAt, 'dueAt');
  if (patch.notes !== undefined) next.notes = typeof patch.notes === 'string' && patch.notes.trim() ? patch.notes.trim().slice(0, 1000) : null;
  if (patch.status !== undefined) {
    if (!isCommitmentStatus(patch.status)) throw badRequest('Status de promessa inválido.');
    if (patch.status !== cur.status) next.completedAt = patch.status === 'pending' ? null : nowIso();
    next.status = patch.status;
  }
  if (typeof patch.lastCheckedAt === 'string' || patch.lastCheckedAt === null) next.lastCheckedAt = patch.lastCheckedAt as string | null;
  if (typeof patch.checkCount === 'number') next.checkCount = patch.checkCount;
  tables.commitments.put(next);
  bus.publish({ type: 'commitment', action: 'updated', commitment: next });
  return next;
}

export function deleteCommitment(id: string): boolean {
  const cur = tables.commitments.get(id);
  if (!cur) return false;
  tables.commitments.delete(id);
  bus.publish({ type: 'commitment', action: 'deleted', commitment: cur });
  return true;
}

export function listCommitments(opts: { status?: string | null } = {}): Commitment[] {
  let list = tables.commitments.all();
  const st = opts.status;
  if (st === 'open') list = list.filter((c) => c.status === 'pending');
  else if (isCommitmentStatus(st)) list = list.filter((c) => c.status === st);
  const due = (c: Commitment) => (c.dueAt ? Date.parse(c.dueAt) : Number.POSITIVE_INFINITY);
  return list.sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (b.status === 'pending' && a.status !== 'pending') return 1;
    if (a.status === 'pending') return due(a) - due(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt);
  });
}

// ─── Lembretes ───────────────────────────────────────────────────────────

export const RECURRENCES: readonly Recurrence[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  none: 'Uma vez',
  daily: 'Todo dia',
  weekdays: 'Dias úteis (seg–sex)',
  weekly: 'Toda semana',
  monthly: 'Todo mês',
};
const REMINDER_STATUSES: readonly ReminderStatus[] = ['scheduled', 'fired', 'dismissed', 'cancelled'];

export function isRecurrence(v: unknown): v is Recurrence {
  return typeof v === 'string' && (RECURRENCES as readonly string[]).includes(v);
}

function requireDate(value: unknown, field: string): string {
  const d = new Date(String(value ?? ''));
  if (!value || Number.isNaN(d.getTime())) throw badRequest(`Data inválida em "${field}". Use ISO-8601 com fuso.`);
  return d.toISOString();
}

export function createReminder(input: { text: unknown; dueAt: unknown; recurrence?: unknown }): Reminder {
  const text = String(input.text ?? '').trim();
  if (!text) throw badRequest('Escreva o texto do lembrete.');
  const r: Reminder = {
    id: newId(),
    text: text.slice(0, 500),
    dueAt: requireDate(input.dueAt, 'dueAt'),
    recurrence: isRecurrence(input.recurrence) ? input.recurrence : 'none',
    status: 'scheduled',
    createdAt: nowIso(),
    firedAt: null,
  };
  tables.reminders.put(r);
  bus.publish({ type: 'reminder', action: 'created', reminder: r });
  return r;
}

export function getReminder(id: string): Reminder | null {
  return tables.reminders.get(id);
}

export function updateReminder(id: string, patch: Record<string, unknown>, opts: { silent?: boolean } = {}): Reminder | null {
  const cur = tables.reminders.get(id);
  if (!cur) return null;
  const next: Reminder = { ...cur };
  if (patch.text !== undefined) {
    const t = String(patch.text ?? '').trim();
    if (!t) throw badRequest('O lembrete não pode ficar vazio.');
    next.text = t.slice(0, 500);
  }
  if (patch.dueAt !== undefined) next.dueAt = requireDate(patch.dueAt, 'dueAt');
  if (patch.recurrence !== undefined) {
    if (!isRecurrence(patch.recurrence)) throw badRequest('Recorrência inválida.');
    next.recurrence = patch.recurrence;
  }
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !(REMINDER_STATUSES as readonly string[]).includes(patch.status)) throw badRequest('Status de lembrete inválido.');
    next.status = patch.status as ReminderStatus;
  }
  if (patch.firedAt !== undefined) next.firedAt = typeof patch.firedAt === 'string' ? patch.firedAt : null;
  tables.reminders.put(next);
  if (!opts.silent) bus.publish({ type: 'reminder', action: 'updated', reminder: next });
  return next;
}

export function deleteReminder(id: string): boolean {
  const cur = tables.reminders.get(id);
  if (!cur) return false;
  tables.reminders.delete(id);
  bus.publish({ type: 'reminder', action: 'deleted', reminder: cur });
  return true;
}

export function listReminders(opts: { status?: string | null; from?: string; to?: string } = {}): Reminder[] {
  let list = tables.reminders.all();
  if (opts.status && (REMINDER_STATUSES as readonly string[]).includes(opts.status)) list = list.filter((r) => r.status === opts.status);
  const from = opts.from ? Date.parse(opts.from) : NaN;
  const to = opts.to ? Date.parse(opts.to) : NaN;
  if (Number.isFinite(from)) list = list.filter((r) => Date.parse(r.dueAt) >= from);
  if (Number.isFinite(to)) list = list.filter((r) => Date.parse(r.dueAt) <= to);
  return list.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

export function getDueReminders(now: Date): Reminder[] {
  const t = now.getTime();
  return tables.reminders.all().filter((r) => r.status === 'scheduled' && Date.parse(r.dueAt) <= t);
}

// ─── Backup ──────────────────────────────────────────────────────────────

export function exportAll(): Record<string, unknown> {
  const settings = loadStored();
  return {
    app: 'lark',
    edition: 'web',
    version: 1,
    exportedAt: nowIso(),
    settings,
    conversations: tables.conversations.all(),
    messages: tables.messages.all(),
    memories: tables.memories.all(),
    commitments: tables.commitments.all(),
    reminders: tables.reminders.all(),
  };
}

function pickArray(src: Record<string, unknown>, key: string): unknown[] {
  const direct = src[key];
  if (Array.isArray(direct)) return direct;
  const data = src.data;
  if (isRecord(data) && Array.isArray(data[key])) return data[key] as unknown[];
  return [];
}

const hasStrings = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof o[k] === 'string');

export function importAll(body: unknown): { ok: true; imported: Record<string, number> } {
  if (!isRecord(body)) throw badRequest('O arquivo não parece um backup do Lärk.');
  const conversations = pickArray(body, 'conversations').filter(isRecord).filter((c) => hasStrings(c, ['id', 'createdAt']));
  const messages = pickArray(body, 'messages').filter(isRecord).filter((m) => hasStrings(m, ['id', 'conversationId', 'role', 'content', 'createdAt']));
  const memories = pickArray(body, 'memories').filter(isRecord).filter((m) => hasStrings(m, ['id', 'content', 'createdAt']));
  const commitments = pickArray(body, 'commitments').filter(isRecord).filter((c) => hasStrings(c, ['id', 'description', 'createdAt']));
  const reminders = pickArray(body, 'reminders').filter(isRecord).filter((r) => hasStrings(r, ['id', 'text', 'dueAt']));
  const total = conversations.length + messages.length + memories.length + commitments.length + reminders.length;
  if (total === 0 && !isRecord(body.settings)) throw badRequest('O arquivo não contém dados do Lärk para importar.');

  const now = nowIso();
  tables.conversations.putMany(
    conversations.map((c) => ({
      id: String(c.id),
      title: typeof c.title === 'string' && c.title ? c.title : DEFAULT_TITLE,
      createdAt: String(c.createdAt),
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : String(c.createdAt),
      summary: typeof c.summary === 'string' ? c.summary : null,
      messageCount: typeof c.messageCount === 'number' ? c.messageCount : 0,
    })),
  );
  tables.messages.putMany(
    messages.map((m) => ({
      id: String(m.id),
      conversationId: String(m.conversationId),
      role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
      content: String(m.content),
      kind: m.kind === 'voice' || m.kind === 'proactive' || m.kind === 'briefing' ? m.kind : 'chat',
      createdAt: String(m.createdAt),
      ...(typeof m.thoughts === 'string' ? { thoughts: m.thoughts } : {}),
      ...(Array.isArray(m.toolCalls) ? { toolCalls: m.toolCalls as ChatMessage['toolCalls'] } : {}),
    })),
  );
  // Conversas citadas por mensagens mas ausentes no backup.
  for (const m of messages) {
    const cid = String(m.conversationId);
    if (!tables.conversations.has(cid)) {
      tables.conversations.put({ id: cid, title: 'Conversa importada', createdAt: String(m.createdAt), updatedAt: String(m.createdAt), summary: null, messageCount: 0 });
    }
  }
  for (const c of tables.conversations.all()) tables.conversations.put({ ...c, messageCount: countMessages(c.id) });

  tables.memories.putMany(
    memories.map((m) => ({
      id: String(m.id),
      content: String(m.content),
      category: isMemoryCategory(m.category) ? m.category : 'other',
      importance: clampImportance(m.importance),
      source: m.source === 'auto' || m.source === 'tool' ? m.source : 'manual',
      pinned: Boolean(m.pinned),
      createdAt: String(m.createdAt),
      updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : String(m.createdAt),
      lastAccessedAt: typeof m.lastAccessedAt === 'string' ? m.lastAccessedAt : null,
      accessCount: typeof m.accessCount === 'number' ? m.accessCount : 0,
    })),
  );
  tables.commitments.putMany(
    commitments.map((c) => ({
      id: String(c.id),
      description: String(c.description),
      dueAt: typeof c.dueAt === 'string' ? c.dueAt : null,
      status: isCommitmentStatus(c.status) ? c.status : 'pending',
      createdAt: String(c.createdAt),
      completedAt: typeof c.completedAt === 'string' ? c.completedAt : null,
      lastCheckedAt: typeof c.lastCheckedAt === 'string' ? c.lastCheckedAt : null,
      checkCount: typeof c.checkCount === 'number' ? c.checkCount : 0,
      notes: typeof c.notes === 'string' ? c.notes : null,
    })),
  );
  tables.reminders.putMany(
    reminders.map((r) => ({
      id: String(r.id),
      text: String(r.text),
      dueAt: String(r.dueAt),
      recurrence: isRecurrence(r.recurrence) ? r.recurrence : 'none',
      status: typeof r.status === 'string' && (REMINDER_STATUSES as readonly string[]).includes(r.status) ? (r.status as ReminderStatus) : 'scheduled',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
      firedAt: typeof r.firedAt === 'string' ? r.firedAt : null,
    })),
  );

  if (isRecord(body.settings)) {
    // Configurações do backup (sem chave e sem acesso ao computador nesta edição).
    const { apiKey: _ignored, hasApiKey: _derived, ...rest } = body.settings;
    void _ignored;
    void _derived;
    try {
      updateSettings({ ...rest, computer: isRecord(rest.computer) ? { ...rest.computer, enabled: false } : undefined });
    } catch {
      /* configurações incompatíveis: mantém as atuais */
    }
  }
  if (!kv.get<string>('firstInteractionAt')) {
    const first = tables.messages.all().map((m) => m.createdAt).sort()[0];
    if (first) kv.set('firstInteractionAt', first);
  }

  return {
    ok: true,
    imported: {
      conversas: conversations.length,
      mensagens: messages.length,
      memórias: memories.length,
      promessas: commitments.length,
      lembretes: reminders.length,
    },
  };
}

