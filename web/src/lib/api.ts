import type {
  ApprovalRequest,
  ChatMessage,
  Commitment,
  CommitmentStatus,
  Conversation,
  HealthInfo,
  Memory,
  MemoryCategory,
  MemorySearchHit,
  MemoryStats,
  ModelInfo,
  Recurrence,
  Reminder,
  ReminderStatus,
  Settings,
  SettingsUpdate,
  SystemVitals,
} from '@shared/types';

/**
 * Cliente HTTP tipado da API REST do Lärk (prefixo /api).
 * - Sempre envia cookies (credentials: 'include') — a sessão por senha é um cookie assinado.
 * - Erros viram ApiError com a mensagem do servidor (pt-BR) quando houver.
 * - 401 dispara o evento de janela 'lark:unauthorized' (o AuthGate escuta e mostra a tela de acesso).
 */

const BASE = '/api';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Evento global disparado quando o servidor responde 401 fora das rotas de autenticação. */
export const UNAUTHORIZED_EVENT = 'lark:unauthorized';

/** URL do stream global de eventos (SSE). */
export const EVENTS_URL = `${BASE}/events`;

export type ApiErrorCode = 'network' | 'timeout' | 'aborted' | 'http' | (string & {});

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, message: string, code: ApiErrorCode = 'http') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Mensagem legível para qualquer erro (para toasts). */
export function errorMessage(e: unknown, fallback = 'Algo saiu do roteiro. Tente novamente.'): string {
  if (e instanceof ApiError || e instanceof Error) return e.message || fallback;
  if (typeof e === 'string' && e) return e;
  return fallback;
}

function statusMessage(status: number): string {
  if (status === 400) return 'O servidor recusou os dados enviados.';
  if (status === 401) return 'Sessão expirada. Entre novamente para continuar.';
  if (status === 403) return 'Acesso negado pelo servidor do Lärk.';
  if (status === 404) return 'Não encontrado — talvez já tenha sido apagado.';
  if (status === 409) return 'Conflito: os dados mudaram enquanto você editava.';
  if (status === 413) return 'O conteúdo é grande demais para ser enviado.';
  if (status === 429) return 'Muitas requisições seguidas. Respire e tente de novo em instantes.';
  if (status >= 500) return 'O núcleo do Lärk encontrou um erro interno.';
  return `A requisição falhou (HTTP ${status}).`;
}

async function readError(res: Response): Promise<ApiError> {
  let message = '';
  let code: ApiErrorCode = 'http';
  try {
    const text = await res.text();
    if (text) {
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const err = j.error;
        if (typeof err === 'string') message = err;
        else if (err && typeof err === 'object') {
          const inner = err as { message?: unknown; code?: unknown };
          if (typeof inner.message === 'string') message = inner.message;
          if (typeof inner.code === 'string') code = inner.code;
        }
        if (!message && typeof j.message === 'string') message = j.message;
        if (typeof j.code === 'string') code = j.code;
      } catch {
        const t = text.trim();
        if (t.length < 280 && !t.startsWith('<')) message = t;
      }
    }
  } catch {
    /* corpo ilegível: usa a mensagem padrão do status */
  }
  return new ApiError(res.status, message || statusMessage(res.status), code);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Não dispara 'lark:unauthorized' (rotas de autenticação). */
  skipAuthEvent?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  let url = `${BASE}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

/** Executa o fetch com timeout e sinal externo combinados; normaliza erros de rede. */
async function send(path: string, opts: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const hasBody = opts.body !== undefined && !(opts.body instanceof FormData);
  try {
    const res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (res.status === 401 && !opts.skipAuthEvent) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    return res;
  } catch (e) {
    if (timedOut) throw new ApiError(0, 'O servidor do Lärk demorou demais para responder.', 'timeout');
    if (opts.signal?.aborted) throw new ApiError(0, 'Requisição cancelada.', 'aborted');
    throw new ApiError(0, 'Sem conexão com o servidor do Lärk.', 'network');
  } finally {
    window.clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'Resposta inválida do servidor do Lärk.', 'parse');
  }
}

const enc = encodeURIComponent;

// ─── Tipos auxiliares de entrada/saída ───────────────────────────────────

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}

export interface VoiceInfo {
  name: string;
  description: string;
}

export interface OkResponse {
  ok: boolean;
}

export interface BriefingResponse {
  /** null quando o servidor decide que não há briefing a gerar agora. */
  message: ChatMessage | null;
}

export interface MemoryListResponse {
  items: Memory[];
  total: number;
}

export interface MemoryQuery {
  q?: string;
  category?: MemoryCategory | null;
  limit?: number;
  offset?: number;
}

export interface MemoryInput {
  content: string;
  category: MemoryCategory;
  importance?: number;
  pinned?: boolean;
}

export type MemoryPatch = Partial<Pick<Memory, 'content' | 'category' | 'importance' | 'pinned'>>;

export interface CommitmentInput {
  description: string;
  dueAt?: string | null;
  notes?: string | null;
}

export type CommitmentPatch = Partial<Pick<Commitment, 'description' | 'dueAt' | 'status' | 'notes'>>;

export interface ReminderInput {
  text: string;
  dueAt: string;
  recurrence?: Recurrence;
}

export type ReminderPatch = Partial<Pick<Reminder, 'text' | 'dueAt' | 'status' | 'recurrence'>>;

/** Backup completo exportado por GET /api/export (estrutura definida pelo servidor). */
export type LarkBackup = Record<string, unknown>;

export interface ImportResult {
  ok: boolean;
  /** Quantidade importada por coleção, quando o servidor informar. */
  imported?: Record<string, number>;
  [key: string]: unknown;
}

export interface TtsOptions {
  /** Voz específica (prévia nas configurações). Sem ela, o servidor usa a voz configurada. */
  voiceName?: string;
  style?: string;
  signal?: AbortSignal;
}

// ─── Cliente ─────────────────────────────────────────────────────────────

export const api = {
  // Sistema e autenticação
  health: (signal?: AbortSignal) => json<HealthInfo>('/health', { signal, timeoutMs: 10_000 }),
  authStatus: () => json<AuthStatus>('/auth/status', { skipAuthEvent: true, timeoutMs: 10_000 }),
  login: (password: string) => json<AuthStatus>('/auth/login', { method: 'POST', body: { password }, skipAuthEvent: true }),
  logout: () => json<AuthStatus>('/auth/logout', { method: 'POST', skipAuthEvent: true }),

  // Conversas
  listConversations: (limit?: number) => json<Conversation[]>('/conversations', { query: { limit } }),
  createConversation: (title?: string) =>
    json<Conversation>('/conversations', { method: 'POST', body: title ? { title } : {} }),
  getActiveConversation: () => json<Conversation>('/conversations/active'),
  updateConversation: (id: string, patch: { title?: string; summary?: string | null }) =>
    json<Conversation>(`/conversations/${enc(id)}`, { method: 'PATCH', body: patch }),
  deleteConversation: (id: string) => json<OkResponse>(`/conversations/${enc(id)}`, { method: 'DELETE' }),
  getMessages: (id: string, opts: { limit?: number; before?: string } = {}) =>
    json<ChatMessage[]>(`/conversations/${enc(id)}/messages`, { query: { limit: opts.limit, before: opts.before } }),
  stopChat: (conversationId: string) => json<OkResponse>('/chat/stop', { method: 'POST', body: { conversationId } }),
  briefing: async (opts: { conversationId?: string; force?: boolean } = {}): Promise<BriefingResponse> => {
    const res = await json<BriefingResponse | undefined>('/briefing', { method: 'POST', body: opts, timeoutMs: 90_000 });
    return { message: res?.message ?? null };
  },

  // Memória
  listMemories: (q: MemoryQuery = {}) =>
    json<MemoryListResponse>('/memories', {
      query: { q: q.q?.trim() || undefined, category: q.category ?? undefined, limit: q.limit, offset: q.offset },
    }),
  memoryStats: () => json<MemoryStats>('/memories/stats'),
  searchMemory: (q: string) => json<MemorySearchHit[]>('/memories/search', { query: { q } }),
  createMemory: (input: MemoryInput) => json<Memory>('/memories', { method: 'POST', body: input }),
  updateMemory: (id: string, patch: MemoryPatch) => json<Memory>(`/memories/${enc(id)}`, { method: 'PATCH', body: patch }),
  deleteMemory: (id: string) => json<OkResponse>(`/memories/${enc(id)}`, { method: 'DELETE' }),

  // Promessas
  listCommitments: (status?: CommitmentStatus | 'open') => json<Commitment[]>('/commitments', { query: { status } }),
  createCommitment: (input: CommitmentInput) => json<Commitment>('/commitments', { method: 'POST', body: input }),
  updateCommitment: (id: string, patch: CommitmentPatch) =>
    json<Commitment>(`/commitments/${enc(id)}`, { method: 'PATCH', body: patch }),
  deleteCommitment: (id: string) => json<OkResponse>(`/commitments/${enc(id)}`, { method: 'DELETE' }),

  // Lembretes
  listReminders: (status?: ReminderStatus) => json<Reminder[]>('/reminders', { query: { status } }),
  createReminder: (input: ReminderInput) => json<Reminder>('/reminders', { method: 'POST', body: input }),
  updateReminder: (id: string, patch: ReminderPatch) =>
    json<Reminder>(`/reminders/${enc(id)}`, { method: 'PATCH', body: patch }),
  deleteReminder: (id: string) => json<OkResponse>(`/reminders/${enc(id)}`, { method: 'DELETE' }),

  // Configurações e modelos
  getSettings: () => json<Settings>('/settings'),
  updateSettings: (patch: SettingsUpdate) => json<Settings>('/settings', { method: 'PUT', body: patch }),
  listModels: () => json<ModelInfo[]>('/models', { timeoutMs: 20_000 }),

  // Aprovações
  listApprovals: () => json<ApprovalRequest[]>('/approvals'),
  resolveApproval: (id: string, approved: boolean) =>
    json<OkResponse>(`/approvals/${enc(id)}`, { method: 'POST', body: { approved } }),

  // Computador
  vitals: (signal?: AbortSignal) => json<SystemVitals>('/system/vitals', { signal, timeoutMs: 15_000 }),

  // Voz
  /** WAV da voz do Lärk (Gemini TTS) ou null quando indisponível (204: sem chave, modo demo, cota). */
  tts: async (text: string, opts: TtsOptions = {}): Promise<Blob | null> => {
    const body: Record<string, string> = { text };
    if (opts.voiceName) body.voiceName = opts.voiceName;
    if (opts.style) body.style = opts.style;
    const res = await send('/tts', { method: 'POST', body, signal: opts.signal, timeoutMs: 60_000 });
    if (res.status === 204) return null;
    if (!res.ok) throw await readError(res);
    const blob = await res.blob();
    return blob.size > 64 ? blob : null;
  },
  voices: () => json<VoiceInfo[]>('/voices'),

  // Dados
  /** Baixa o backup completo. Devolve o arquivo pronto para salvar e o nome sugerido. */
  exportData: async (): Promise<{ blob: Blob; filename: string }> => {
    const res = await send('/export', { timeoutMs: 120_000 });
    if (!res.ok) throw await readError(res);
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const stamp = new Date().toISOString().slice(0, 10);
    return { blob, filename: match?.[1] ? decodeURIComponent(match[1]) : `lark-backup-${stamp}.json` };
  },
  importData: (data: LarkBackup) => json<ImportResult>('/import', { method: 'POST', body: data, timeoutMs: 180_000 }),
} as const;

export type Api = typeof api;
