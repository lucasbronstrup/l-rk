import { create } from 'zustand';
import type {
  ApprovalRequest,
  Commitment,
  Conversation,
  HealthInfo,
  LarkEvent,
  Memory,
  MemoryCategory,
  MemoryStats,
  ModelInfo,
  Reminder,
  Settings,
  SettingsUpdate,
  SystemVitals,
} from '@shared/types';
import {
  api,
  errorMessage,
  isApiError,
  type CommitmentInput,
  type CommitmentPatch,
  type MemoryInput,
  type MemoryPatch,
  type ReminderInput,
  type ReminderPatch,
  type VoiceInfo,
} from '@/lib/api';

/**
 * Estado de dados do Lärk: tudo o que vem do servidor (configurações, memória, promessas,
 * lembretes, conversas, sinais vitais, aprovações) + a fila de notificações da interface.
 * As ações de escrita são otimistas: a interface muda na hora e volta atrás se o servidor recusar.
 */

// ─── Tipos ───────────────────────────────────────────────────────────────

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ToastKind = 'info' | 'success' | 'warn' | 'error' | 'reminder' | 'checkin' | 'memory' | 'approval' | 'message';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** Tempo de exibição em ms; 0 = permanece até ser fechado. */
  duration: number;
  createdAt: number;
  /** Um novo toast com a mesma chave substitui o anterior (evita pilhas repetidas). */
  key?: string;
  action?: ToastAction;
}

export interface ToastInput {
  kind?: ToastKind;
  title: string;
  body?: string;
  duration?: number;
  key?: string;
  action?: ToastAction;
}

export type SnoozeTarget = '10m' | '1h' | 'tomorrow';

/** Entidades criadas localmente (para não anunciar como "registrado pelo Lärk" o que o próprio usuário criou). */
export type LocalEntity = 'memory' | 'commitment' | 'reminder';

interface DataState {
  // Autenticação
  authRequired: boolean | null;
  authenticated: boolean | null;

  // Núcleo
  health: HealthInfo | null;
  settings: Settings | null;
  settingsSaving: boolean;
  models: ModelInfo[] | null;
  modelsError: string | null;
  voices: VoiceInfo[] | null;

  // Memória
  memories: Memory[];
  memoriesTotal: number;
  memoryQuery: string;
  memoryCategory: MemoryCategory | null;
  memoriesStatus: LoadStatus;
  memoriesError: string | null;
  memoriesLoadingMore: boolean;
  memoryStats: MemoryStats | null;
  /** Memórias recém-chegadas (destaque animado por alguns segundos). */
  freshMemoryIds: string[];

  // Promessas, lembretes, conversas
  commitments: Commitment[];
  commitmentsStatus: LoadStatus;
  reminders: Reminder[];
  remindersStatus: LoadStatus;
  conversations: Conversation[];
  conversationsStatus: LoadStatus;

  // Computador
  vitals: SystemVitals | null;
  vitalsError: string | null;
  vitalsAt: number | null;

  // Aprovações pendentes (fila) e notificações
  approvals: ApprovalRequest[];
  toasts: Toast[];

  // ── Ações ──
  setAuth(patch: { required?: boolean; authenticated?: boolean }): void;
  loadAll(): Promise<void>;
  loadHealth(): Promise<void>;
  loadSettings(): Promise<void>;
  saveSettings(patch: SettingsUpdate, opts?: { toast?: string | false }): Promise<boolean>;
  loadModels(): Promise<void>;
  loadVoices(): Promise<void>;

  loadMemories(): Promise<void>;
  loadMoreMemories(): Promise<void>;
  setMemoryFilter(patch: { q?: string; category?: MemoryCategory | null }): void;
  loadMemoryStats(): Promise<void>;
  createMemory(input: MemoryInput): Promise<Memory | null>;
  updateMemory(id: string, patch: MemoryPatch): Promise<Memory | null>;
  deleteMemory(id: string): Promise<boolean>;

  loadCommitments(): Promise<void>;
  createCommitment(input: CommitmentInput): Promise<Commitment | null>;
  updateCommitment(id: string, patch: CommitmentPatch): Promise<Commitment | null>;
  deleteCommitment(id: string): Promise<boolean>;

  loadReminders(): Promise<void>;
  createReminder(input: ReminderInput): Promise<Reminder | null>;
  updateReminder(id: string, patch: ReminderPatch): Promise<Reminder | null>;
  snoozeReminder(id: string, target: SnoozeTarget): Promise<Reminder | null>;
  dismissReminder(id: string): Promise<Reminder | null>;
  deleteReminder(id: string): Promise<boolean>;

  loadConversations(): Promise<void>;
  renameConversation(id: string, title: string): Promise<Conversation | null>;
  deleteConversation(id: string): Promise<boolean>;

  loadVitals(signal?: AbortSignal): Promise<void>;

  loadApprovals(): Promise<void>;
  resolveApproval(id: string, approved: boolean): Promise<boolean>;
  expireApproval(id: string): void;

  applyEvent(e: LarkEvent): void;

  pushToast(t: ToastInput): string;
  dismissToast(id: string): void;
}

// ─── Utilidades internas ────────────────────────────────────────────────

const MEMORY_PAGE = 40;
const MAX_TOASTS = 5;
const FRESH_MS = 6000;

const DEFAULT_DURATION: Record<ToastKind, number> = {
  info: 4500,
  success: 3500,
  memory: 4000,
  warn: 6500,
  error: 7000,
  message: 8000,
  reminder: 14000,
  checkin: 14000,
  approval: 9000,
};

let toastSeq = 0;
let tempSeq = 0;
const tempId = (prefix: string) => `tmp-${prefix}-${Date.now().toString(36)}-${(++tempSeq).toString(36)}`;
const nowIso = () => new Date().toISOString();

/** Substitui (ou insere no início) um item por id. */
function upsert<T extends { id: string }>(list: T[], item: T, where: 'start' | 'end' = 'start'): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return where === 'start' ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

const without = <T extends { id: string }>(list: T[], id: string) => list.filter((x) => x.id !== id);

function sortConversations(list: Conversation[]): Conversation[] {
  return list.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function memoryMatchesFilter(m: Memory, q: string, category: MemoryCategory | null): boolean {
  if (category && m.category !== category) return false;
  const needle = q.trim().toLowerCase();
  return !needle || m.content.toLowerCase().includes(needle);
}

function mergeSettings(base: Settings, patch: SettingsUpdate): Settings {
  const { apiKey, models, computer, proactive, ...flat } = patch;
  return {
    ...base,
    ...flat,
    hasApiKey: apiKey !== undefined ? apiKey.trim().length > 0 || base.hasApiKey : base.hasApiKey,
    models: { ...base.models, ...(models ?? {}) } as Settings['models'],
    computer: { ...base.computer, ...(computer ?? {}) },
    proactive: { ...base.proactive, ...(proactive ?? {}) },
  };
}

/** Próximo horário para "adiar" um lembrete. */
export function snoozeDate(reminder: Pick<Reminder, 'dueAt'>, target: SnoozeTarget, now: number = Date.now()): Date {
  const due = Date.parse(reminder.dueAt);
  const base = Number.isFinite(due) ? Math.max(now, due) : now;
  if (target === '10m') return new Date(base + 10 * 60_000);
  if (target === '1h') return new Date(base + 60 * 60_000);
  // Amanhã, no mesmo horário do lembrete original (ou às 9h se a hora original não for válida).
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  if (Number.isFinite(due)) {
    const o = new Date(due);
    d.setHours(o.getHours(), o.getMinutes(), 0, 0);
  } else d.setHours(9, 0, 0, 0);
  return d;
}

// Criações locais em andamento/recentes — o bootstrap consulta para não anunciar como novidade.
const localInFlight: Record<LocalEntity, number> = { memory: 0, commitment: 0, reminder: 0 };
const localRecentIds = new Set<string>();

function trackLocal<T extends { id: string }>(kind: LocalEntity, run: () => Promise<T>): Promise<T> {
  localInFlight[kind]++;
  return run()
    .then((item) => {
      localRecentIds.add(item.id);
      window.setTimeout(() => localRecentIds.delete(item.id), 15_000);
      return item;
    })
    .finally(() => {
      // Mantém a marca por um instante: o evento SSE pode chegar logo depois da resposta.
      window.setTimeout(() => {
        localInFlight[kind] = Math.max(0, localInFlight[kind] - 1);
      }, 1500);
    });
}

/** true quando um evento 'created' provavelmente foi disparado por uma ação local do usuário. */
export function isLocalCreation(kind: LocalEntity, id: string): boolean {
  return localInFlight[kind] > 0 || localRecentIds.has(id);
}

let statsTimer: number | undefined;
let memoriesToken = 0;

// ─── Store ───────────────────────────────────────────────────────────────

export const useData = create<DataState>((set, get) => {
  const toastError = (e: unknown, title = 'Não foi possível concluir') => {
    get().pushToast({ kind: 'error', title, body: errorMessage(e) });
  };

  /** Recarrega as estatísticas da memória em lote (vários eventos seguidos → uma requisição). */
  const refreshStatsSoon = () => {
    window.clearTimeout(statsTimer);
    statsTimer = window.setTimeout(() => void get().loadMemoryStats(), 1500);
  };

  const markFresh = (id: string) => {
    set((s) => ({ freshMemoryIds: s.freshMemoryIds.includes(id) ? s.freshMemoryIds : [...s.freshMemoryIds, id] }));
    window.setTimeout(() => set((s) => ({ freshMemoryIds: s.freshMemoryIds.filter((x) => x !== id) })), FRESH_MS);
  };

  const bumpStats = (delta: number, category?: MemoryCategory) => {
    const stats = get().memoryStats;
    if (!stats) return;
    const byCategory = { ...stats.byCategory };
    if (category) byCategory[category] = Math.max(0, (byCategory[category] ?? 0) + delta);
    set({ memoryStats: { ...stats, memories: Math.max(0, stats.memories + delta), byCategory } });
  };

  return {
    authRequired: null,
    authenticated: null,

    health: null,
    settings: null,
    settingsSaving: false,
    models: null,
    modelsError: null,
    voices: null,

    memories: [],
    memoriesTotal: 0,
    memoryQuery: '',
    memoryCategory: null,
    memoriesStatus: 'idle',
    memoriesError: null,
    memoriesLoadingMore: false,
    memoryStats: null,
    freshMemoryIds: [],

    commitments: [],
    commitmentsStatus: 'idle',
    reminders: [],
    remindersStatus: 'idle',
    conversations: [],
    conversationsStatus: 'idle',

    vitals: null,
    vitalsError: null,
    vitalsAt: null,

    approvals: [],
    toasts: [],

    // ── Autenticação ──
    setAuth(patch) {
      set((s) => ({
        authRequired: patch.required ?? s.authRequired,
        authenticated: patch.authenticated ?? s.authenticated,
      }));
    },

    // ── Carga inicial ──
    async loadAll() {
      const s = get();
      await Promise.allSettled([
        s.loadHealth(),
        s.loadSettings(),
        s.loadMemoryStats(),
        s.loadMemories(),
        s.loadCommitments(),
        s.loadReminders(),
        s.loadConversations(),
        s.loadApprovals(),
      ]);
    },

    async loadHealth() {
      try {
        set({ health: await api.health() });
      } catch {
        /* sem servidor: a barra superior já mostra o estado offline */
      }
    },

    async loadSettings() {
      try {
        set({ settings: await api.getSettings() });
      } catch (e) {
        if (!get().settings) console.warn('[Lärk] Configurações indisponíveis:', errorMessage(e));
      }
    },

    async saveSettings(patch, opts = {}) {
      const prev = get().settings;
      if (prev) set({ settings: mergeSettings(prev, patch) });
      set({ settingsSaving: true });
      try {
        const saved = await api.updateSettings(patch);
        set({ settings: saved, settingsSaving: false });
        if (patch.models || patch.apiKey !== undefined) void get().loadHealth();
        if (opts.toast !== false) {
          get().pushToast({ kind: 'success', title: opts.toast ?? 'Configuração salva', key: 'settings-saved', duration: 2200 });
        }
        return true;
      } catch (e) {
        set({ settings: prev, settingsSaving: false });
        toastError(e, 'Configuração não salva');
        void get().loadSettings();
        return false;
      }
    },

    async loadModels() {
      try {
        set({ models: await api.listModels(), modelsError: null });
      } catch (e) {
        set({ modelsError: errorMessage(e) });
      }
    },

    async loadVoices() {
      try {
        set({ voices: await api.voices() });
      } catch (e) {
        if (!get().voices) set({ voices: [] });
        console.warn('[Lärk] Lista de vozes indisponível:', errorMessage(e));
      }
    },

    // ── Memória ──
    async loadMemories() {
      const token = ++memoriesToken;
      const { memoryQuery, memoryCategory, memories } = get();
      set({ memoriesStatus: memories.length ? 'ready' : 'loading', memoriesError: null });
      try {
        const res = await api.listMemories({ q: memoryQuery, category: memoryCategory, limit: MEMORY_PAGE, offset: 0 });
        if (token !== memoriesToken) return;
        set({ memories: res.items, memoriesTotal: res.total, memoriesStatus: 'ready' });
      } catch (e) {
        if (token !== memoriesToken) return;
        set({ memoriesStatus: 'error', memoriesError: errorMessage(e) });
      }
    },

    async loadMoreMemories() {
      const { memories, memoriesTotal, memoriesLoadingMore, memoryQuery, memoryCategory } = get();
      if (memoriesLoadingMore || memories.length >= memoriesTotal) return;
      const token = memoriesToken;
      set({ memoriesLoadingMore: true });
      try {
        const res = await api.listMemories({
          q: memoryQuery,
          category: memoryCategory,
          limit: MEMORY_PAGE,
          offset: memories.filter((m) => !m.id.startsWith('tmp-')).length,
        });
        if (token !== memoriesToken) return;
        set((s) => {
          const known = new Set(s.memories.map((m) => m.id));
          return { memories: [...s.memories, ...res.items.filter((m) => !known.has(m.id))], memoriesTotal: res.total };
        });
      } catch (e) {
        toastError(e, 'Falha ao carregar mais memórias');
      } finally {
        set({ memoriesLoadingMore: false });
      }
    },

    setMemoryFilter(patch) {
      const next = {
        memoryQuery: patch.q ?? get().memoryQuery,
        memoryCategory: patch.category === undefined ? get().memoryCategory : patch.category,
      };
      if (next.memoryQuery === get().memoryQuery && next.memoryCategory === get().memoryCategory) return;
      set({ ...next, memories: [], memoriesTotal: 0, memoriesStatus: 'loading' });
      void get().loadMemories();
    },

    async loadMemoryStats() {
      try {
        set({ memoryStats: await api.memoryStats() });
      } catch {
        /* estatísticas são decorativas: mantém as anteriores */
      }
    },

    async createMemory(input) {
      const temp: Memory = {
        id: tempId('mem'),
        content: input.content,
        category: input.category,
        importance: input.importance ?? 3,
        source: 'manual',
        pinned: input.pinned ?? false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastAccessedAt: null,
        accessCount: 0,
      };
      set((s) => ({ memories: [temp, ...s.memories], memoriesTotal: s.memoriesTotal + 1 }));
      try {
        const saved = await trackLocal('memory', () => api.createMemory(input));
        set((s) => {
          const alreadyThere = s.memories.some((m) => m.id === saved.id);
          return {
            memories: alreadyThere ? without(s.memories, temp.id).map((m) => (m.id === saved.id ? saved : m)) : s.memories.map((m) => (m.id === temp.id ? saved : m)),
            memoriesTotal: alreadyThere ? s.memoriesTotal - 1 : s.memoriesTotal,
          };
        });
        bumpStats(1, saved.category);
        refreshStatsSoon();
        markFresh(saved.id);
        return saved;
      } catch (e) {
        set((s) => ({ memories: without(s.memories, temp.id), memoriesTotal: Math.max(0, s.memoriesTotal - 1) }));
        toastError(e, 'Memória não registrada');
        return null;
      }
    },

    async updateMemory(id, patch) {
      const prev = get().memories.find((m) => m.id === id);
      if (prev) set((s) => ({ memories: upsert(s.memories, { ...prev, ...patch, updatedAt: nowIso() }) }));
      try {
        const saved = await api.updateMemory(id, patch);
        set((s) => ({ memories: s.memories.some((m) => m.id === id) ? upsert(s.memories, saved) : s.memories }));
        if (patch.category && prev && patch.category !== prev.category) refreshStatsSoon();
        return saved;
      } catch (e) {
        if (prev) set((s) => ({ memories: s.memories.some((m) => m.id === id) ? upsert(s.memories, prev) : s.memories }));
        toastError(e, 'Memória não atualizada');
        return null;
      }
    },

    async deleteMemory(id) {
      const list = get().memories;
      const index = list.findIndex((m) => m.id === id);
      const prev = list[index];
      set((s) => ({ memories: without(s.memories, id), memoriesTotal: Math.max(0, s.memoriesTotal - (prev ? 1 : 0)) }));
      try {
        await api.deleteMemory(id);
        if (prev) bumpStats(-1, prev.category);
        refreshStatsSoon();
        return true;
      } catch (e) {
        if (isApiError(e) && e.status === 404) return true;
        if (prev) {
          set((s) => {
            const next = s.memories.slice();
            next.splice(Math.min(index, next.length), 0, prev);
            return { memories: next, memoriesTotal: s.memoriesTotal + 1 };
          });
        }
        toastError(e, 'Memória não apagada');
        return false;
      }
    },

    // ── Promessas ──
    async loadCommitments() {
      if (!get().commitments.length) set({ commitmentsStatus: 'loading' });
      try {
        set({ commitments: await api.listCommitments(), commitmentsStatus: 'ready' });
      } catch {
        set((s) => ({ commitmentsStatus: s.commitments.length ? 'ready' : 'error' }));
      }
    },

    async createCommitment(input) {
      const temp: Commitment = {
        id: tempId('prm'),
        description: input.description,
        dueAt: input.dueAt ?? null,
        status: 'pending',
        createdAt: nowIso(),
        completedAt: null,
        lastCheckedAt: null,
        checkCount: 0,
        notes: input.notes ?? null,
      };
      set((s) => ({ commitments: [temp, ...s.commitments] }));
      try {
        const saved = await trackLocal('commitment', () => api.createCommitment(input));
        set((s) => ({ commitments: upsert(without(s.commitments, temp.id), saved) }));
        return saved;
      } catch (e) {
        set((s) => ({ commitments: without(s.commitments, temp.id) }));
        toastError(e, 'Promessa não registrada');
        return null;
      }
    },

    async updateCommitment(id, patch) {
      const prev = get().commitments.find((c) => c.id === id);
      if (prev) {
        const closing = patch.status && patch.status !== 'pending';
        const optimistic: Commitment = {
          ...prev,
          ...patch,
          completedAt: closing ? nowIso() : patch.status === 'pending' ? null : prev.completedAt,
        };
        set((s) => ({ commitments: upsert(s.commitments, optimistic) }));
      }
      try {
        const saved = await api.updateCommitment(id, patch);
        set((s) => ({ commitments: upsert(s.commitments, saved) }));
        return saved;
      } catch (e) {
        if (prev) set((s) => ({ commitments: upsert(s.commitments, prev) }));
        toastError(e, 'Promessa não atualizada');
        return null;
      }
    },

    async deleteCommitment(id) {
      const prev = get().commitments.find((c) => c.id === id);
      set((s) => ({ commitments: without(s.commitments, id) }));
      try {
        await api.deleteCommitment(id);
        return true;
      } catch (e) {
        if (isApiError(e) && e.status === 404) return true;
        if (prev) set((s) => ({ commitments: upsert(s.commitments, prev, 'end') }));
        toastError(e, 'Promessa não apagada');
        return false;
      }
    },

    // ── Lembretes ──
    async loadReminders() {
      if (!get().reminders.length) set({ remindersStatus: 'loading' });
      try {
        set({ reminders: await api.listReminders(), remindersStatus: 'ready' });
      } catch {
        set((s) => ({ remindersStatus: s.reminders.length ? 'ready' : 'error' }));
      }
    },

    async createReminder(input) {
      const temp: Reminder = {
        id: tempId('rmd'),
        text: input.text,
        dueAt: input.dueAt,
        recurrence: input.recurrence ?? 'none',
        status: 'scheduled',
        createdAt: nowIso(),
        firedAt: null,
      };
      set((s) => ({ reminders: [...s.reminders, temp] }));
      try {
        const saved = await trackLocal('reminder', () => api.createReminder(input));
        set((s) => ({ reminders: upsert(without(s.reminders, temp.id), saved, 'end') }));
        return saved;
      } catch (e) {
        set((s) => ({ reminders: without(s.reminders, temp.id) }));
        toastError(e, 'Lembrete não agendado');
        return null;
      }
    },

    async updateReminder(id, patch) {
      const prev = get().reminders.find((r) => r.id === id);
      if (prev) set((s) => ({ reminders: upsert(s.reminders, { ...prev, ...patch }) }));
      try {
        const saved = await api.updateReminder(id, patch);
        set((s) => ({ reminders: upsert(s.reminders, saved) }));
        return saved;
      } catch (e) {
        if (prev) set((s) => ({ reminders: upsert(s.reminders, prev) }));
        toastError(e, 'Lembrete não atualizado');
        return null;
      }
    },

    async snoozeReminder(id, target) {
      const r = get().reminders.find((x) => x.id === id);
      if (!r) return null;
      const due = snoozeDate(r, target);
      return get().updateReminder(id, { dueAt: due.toISOString(), status: 'scheduled' });
    },

    async dismissReminder(id) {
      return get().updateReminder(id, { status: 'dismissed' });
    },

    async deleteReminder(id) {
      const prev = get().reminders.find((r) => r.id === id);
      set((s) => ({ reminders: without(s.reminders, id) }));
      try {
        await api.deleteReminder(id);
        return true;
      } catch (e) {
        if (isApiError(e) && e.status === 404) return true;
        if (prev) set((s) => ({ reminders: upsert(s.reminders, prev, 'end') }));
        toastError(e, 'Lembrete não apagado');
        return false;
      }
    },

    // ── Conversas ──
    async loadConversations() {
      if (!get().conversations.length) set({ conversationsStatus: 'loading' });
      try {
        set({ conversations: sortConversations(await api.listConversations()), conversationsStatus: 'ready' });
      } catch {
        set((s) => ({ conversationsStatus: s.conversations.length ? 'ready' : 'error' }));
      }
    },

    async renameConversation(id, title) {
      const clean = title.trim();
      const prev = get().conversations.find((c) => c.id === id);
      if (!clean || (prev && prev.title === clean)) return prev ?? null;
      if (prev) set((s) => ({ conversations: upsert(s.conversations, { ...prev, title: clean }) }));
      try {
        const saved = await api.updateConversation(id, { title: clean });
        set((s) => ({ conversations: upsert(s.conversations, saved) }));
        return saved;
      } catch (e) {
        if (prev) set((s) => ({ conversations: upsert(s.conversations, prev) }));
        toastError(e, 'Conversa não renomeada');
        return null;
      }
    },

    async deleteConversation(id) {
      const prev = get().conversations;
      set((s) => ({ conversations: without(s.conversations, id) }));
      try {
        await api.deleteConversation(id);
        refreshStatsSoon();
        return true;
      } catch (e) {
        if (isApiError(e) && e.status === 404) return true;
        set({ conversations: prev });
        toastError(e, 'Conversa não apagada');
        return false;
      }
    },

    // ── Computador ──
    async loadVitals(signal) {
      try {
        const vitals = await api.vitals(signal);
        set({ vitals, vitalsError: null, vitalsAt: Date.now() });
      } catch (e) {
        if (isApiError(e) && e.code === 'aborted') return;
        set({ vitalsError: errorMessage(e, 'Sensores indisponíveis.') });
      }
    },

    // ── Aprovações ──
    async loadApprovals() {
      try {
        const list = await api.listApprovals();
        const now = Date.now();
        set({ approvals: list.filter((a) => Date.parse(a.expiresAt) > now) });
      } catch {
        /* sem aprovações pendentes conhecidas */
      }
    },

    async resolveApproval(id, approved) {
      const prev = get().approvals.find((a) => a.id === id);
      set((s) => ({ approvals: without(s.approvals, id) }));
      try {
        await api.resolveApproval(id, approved);
        return true;
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.status === 410)) {
          get().pushToast({ kind: 'warn', title: 'Solicitação encerrada', body: 'Essa autorização já havia expirado ou sido respondida.' });
          return false;
        }
        if (prev && Date.parse(prev.expiresAt) > Date.now()) set((s) => ({ approvals: upsert(s.approvals, prev, 'start') }));
        toastError(e, 'Resposta não enviada');
        return false;
      }
    },

    expireApproval(id) {
      set((s) => ({ approvals: without(s.approvals, id) }));
    },

    // ── Eventos em tempo real ──
    applyEvent(e) {
      switch (e.type) {
        case 'hello':
        case 'ping':
          return;

        case 'message': {
          const m = e.message;
          set((s) => {
            const conv = s.conversations.find((c) => c.id === m.conversationId);
            if (!conv) return {};
            const updated = { ...conv, updatedAt: m.createdAt, messageCount: conv.messageCount + 1 };
            return { conversations: sortConversations(upsert(s.conversations, updated)) };
          });
          refreshStatsSoon();
          return;
        }

        case 'reminder_fired':
          set((s) => ({ reminders: upsert(s.reminders, e.reminder, 'end') }));
          return;

        case 'checkin':
          set((s) => ({ commitments: upsert(s.commitments, e.commitment) }));
          return;

        case 'memory': {
          const m = e.memory;
          if (e.action === 'deleted') {
            const had = get().memories.some((x) => x.id === m.id);
            set((s) => ({ memories: without(s.memories, m.id), memoriesTotal: Math.max(0, s.memoriesTotal - (had ? 1 : 0)) }));
            refreshStatsSoon();
            return;
          }
          if (e.action === 'created') {
            const s = get();
            const known = s.memories.some((x) => x.id === m.id);
            if (!known && !isLocalCreation('memory', m.id)) bumpStats(1, m.category);
            if (!known && memoryMatchesFilter(m, s.memoryQuery, s.memoryCategory)) {
              set((st) => ({ memories: [m, ...st.memories], memoriesTotal: st.memoriesTotal + 1 }));
              markFresh(m.id);
            }
            refreshStatsSoon();
            return;
          }
          set((s) => ({ memories: s.memories.some((x) => x.id === m.id) ? upsert(s.memories, m) : s.memories }));
          return;
        }

        case 'commitment':
          set((s) => ({
            commitments: e.action === 'deleted' ? without(s.commitments, e.commitment.id) : upsert(s.commitments, e.commitment),
          }));
          return;

        case 'reminder':
          set((s) => ({
            reminders: e.action === 'deleted' ? without(s.reminders, e.reminder.id) : upsert(s.reminders, e.reminder, 'end'),
          }));
          return;

        case 'conversation':
          set((s) => ({
            conversations:
              e.action === 'deleted' ? without(s.conversations, e.conversation.id) : sortConversations(upsert(s.conversations, e.conversation)),
          }));
          if (e.action !== 'updated') refreshStatsSoon();
          return;

        case 'approval_request':
          if (Date.parse(e.request.expiresAt) <= Date.now()) return;
          set((s) => ({ approvals: upsert(s.approvals, e.request, 'end') }));
          return;

        case 'approval_resolved':
          set((s) => ({ approvals: without(s.approvals, e.id) }));
          return;

        case 'settings':
          set({ settings: e.settings });
          return;
      }
    },

    // ── Notificações ──
    pushToast(t) {
      const kind = t.kind ?? 'info';
      const toast: Toast = {
        id: `t${Date.now().toString(36)}${(++toastSeq).toString(36)}`,
        kind,
        title: t.title,
        body: t.body,
        duration: t.duration ?? DEFAULT_DURATION[kind],
        createdAt: Date.now(),
        key: t.key,
        action: t.action,
      };
      set((s) => {
        const base = t.key ? s.toasts.filter((x) => x.key !== t.key) : s.toasts;
        const next = [...base, toast];
        return { toasts: next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next };
      });
      return toast.id;
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
});

/** Atalho para disparar uma notificação de qualquer lugar. */
export const toast = (t: ToastInput): string => useData.getState().pushToast(t);
