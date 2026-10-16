import { create } from 'zustand';
import type { ChatMessage, ChatStreamEvent, Conversation, MessageKind, ToolCallInfo } from '@shared/types';
import { HttpError, isAbortError, postSSE, readHttpError } from '@/lib/stream';
import { speak, stopSpeaking } from '@/lib/audio/speak';
import { playSfx } from '@/lib/sfx';
import { useUi } from '@/store/ui';
import { useData } from '@/store/data';

/** Códigos de erro conhecidos do chat (do servidor) + falhas locais. */
export type ChatErrorCode = 'no_api_key' | 'quota' | 'provider' | 'internal' | 'network' | 'auth';

export interface SendOptions {
  /** Origem da mensagem do usuário (exibição). Padrão: 'chat'. */
  kind?: MessageKind;
  /** Força falar (true) ou não (false) a resposta. Padrão: settings.speakInChat. */
  speak?: boolean;
}

interface ChatState {
  conversationId: string | null;
  conversation: Conversation | null;
  messages: ChatMessage[];
  streaming: boolean;
  /** Id da mensagem do Lärk sendo gerada agora. */
  streamingId: string | null;
  error: string | null;
  errorCode: ChatErrorCode | null;
  /** Carregamento inicial (conversa ativa). */
  loading: boolean;
  initialized: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  /** Última resposta concluída do Lärk (usada pelo modo de voz clássico). */
  lastReply: ChatMessage | null;
  /** Último texto enviado (para "tentar novamente"). */
  lastUserText: string | null;

  init(): Promise<void>;
  sendMessage(text: string, opts?: SendOptions): Promise<void>;
  stop(): void;
  retry(): Promise<void>;
  loadConversation(id: string): Promise<void>;
  newConversation(): Promise<void>;
  loadOlder(): Promise<void>;
  receiveProactive(msg: ChatMessage): void;
  appendMessages(msgs: ChatMessage[]): void;
  clearError(): void;
}

const PAGE_SIZE = 40;
const FLUSH_MS = 33;

// ─── HTTP ─────────────────────────────────────────────────────────────────

async function requestJson<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    credentials: 'include',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal,
  });
  if (!res.ok) throw await readHttpError(res);
  return (await res.json()) as T;
}

function fetchMessages(conversationId: string, before?: string): Promise<ChatMessage[]> {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (before) q.set('before', before);
  return requestJson<ChatMessage[]>(`/api/conversations/${encodeURIComponent(conversationId)}/messages?${q}`);
}

// ─── Mensagens amigáveis ──────────────────────────────────────────────────

const FRIENDLY: Record<ChatErrorCode, string> = {
  no_api_key:
    'Ainda não tenho minha chave do Google AI Studio — sem ela, meu pensamento fica em silêncio. Abra as Configurações e cole sua chave gratuita: em um minuto estaremos conversando.',
  quota:
    'Chegamos ao limite gratuito da API do Gemini por agora. Toda pausa também ensina algo: em alguns instantes podemos tentar de novo.',
  provider: 'O provedor de IA não respondeu como deveria. Tente novamente em instantes.',
  internal: 'Algo falhou no núcleo do Lärk ao processar sua mensagem.',
  network: 'Não consegui alcançar o núcleo do Lärk. Verifique se o servidor está em execução e tente de novo.',
  auth: 'Sua sessão expirou. Entre novamente para continuar.',
};

function describeError(e: unknown): { message: string; code: ChatErrorCode } {
  if (e instanceof HttpError) {
    if (e.status === 401) return { message: FRIENDLY.auth, code: 'auth' };
    const code = (['no_api_key', 'quota', 'provider', 'internal'] as const).find((c) => c === e.code);
    if (code === 'no_api_key' || code === 'quota') return { message: FRIENDLY[code], code };
    if (e.status === 429) return { message: FRIENDLY.quota, code: 'quota' };
    return { message: e.message || FRIENDLY.internal, code: code ?? 'internal' };
  }
  if (e instanceof TypeError) return { message: FRIENDLY.network, code: 'network' };
  return { message: e instanceof Error && e.message ? e.message : FRIENDLY.internal, code: 'internal' };
}

// ─── Utilidades ───────────────────────────────────────────────────────────

const isLocalId = (id: string) => id.startsWith('local-') || id.startsWith('failed-');

/** Mescla listas por id, preservando a ordem cronológica (createdAt) e o conteúdo mais recente. */
function mergeMessages(base: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of base) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => {
    const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (t !== 0) return t;
    if (a.role !== b.role) return a.role === 'user' ? -1 : 1;
    return 0;
  });
}

function upsertTool(list: ToolCallInfo[] | undefined, call: ToolCallInfo): ToolCallInfo[] {
  const arr = list ? [...list] : [];
  const i = arr.findIndex((c) => c.id === call.id);
  if (i >= 0) arr[i] = { ...arr[i], ...call };
  else arr.push(call);
  return arr;
}

function settings() {
  return useData.getState().settings ?? null;
}

let localSeq = 0;
/** id real → id local original: mantém a chave React estável quando o servidor confirma o id. */
const keyAliases = new Map<string, string>();

/** Chave estável para listas React (não remonta a bolha quando o id local vira o id real). */
export function messageKey(id: string): string {
  return keyAliases.get(id) ?? id;
}

let activeController: AbortController | null = null;
let initPromise: Promise<void> | null = null;
let alertTimer: ReturnType<typeof setTimeout> | null = null;

function flashAlert() {
  const ui = useUi.getState();
  if (ui.voiceMode) return;
  ui.setOrbState('alert');
  if (alertTimer) clearTimeout(alertTimer);
  alertTimer = setTimeout(() => {
    if (useUi.getState().orbState === 'alert') useUi.getState().setOrbState('idle');
  }, 1800);
}

function releaseThinking() {
  const ui = useUi.getState();
  if (ui.orbState === 'thinking' && !ui.voiceMode) ui.setOrbState('idle');
}

// ─── Store ────────────────────────────────────────────────────────────────

export const useChat = create<ChatState>((set, get) => {
  /** Atualiza uma mensagem pelo id, recriando só o objeto alterado (bolhas memoizadas). */
  const patchMessage = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) }));

  return {
    conversationId: null,
    conversation: null,
    messages: [],
    streaming: false,
    streamingId: null,
    error: null,
    errorCode: null,
    loading: false,
    initialized: false,
    loadingOlder: false,
    hasMore: false,
    lastReply: null,
    lastUserText: null,

    init() {
      if (get().initialized) return Promise.resolve();
      if (initPromise) return initPromise;
      initPromise = (async () => {
        set({ loading: true });
        try {
          const conv = await requestJson<Conversation>('/api/conversations/active');
          const msgs = await fetchMessages(conv.id);
          set((s) => {
            const clearStale = s.errorCode === 'network' || s.errorCode === 'auth';
            const base = {
              loading: false,
              initialized: true,
              error: clearStale ? null : s.error,
              errorCode: clearStale ? null : s.errorCode,
            };
            // Outra conversa já foi aberta enquanto carregávamos: não misture históricos.
            if (s.conversationId && s.conversationId !== conv.id) return base;
            return {
              ...base,
              conversationId: conv.id,
              conversation: s.conversation ?? conv,
              messages: mergeMessages(msgs, s.messages.filter((m) => !m.conversationId || m.conversationId === conv.id)),
              hasMore: msgs.length >= PAGE_SIZE,
            };
          });
        } catch (e) {
          const { message, code } = describeError(e);
          set({ loading: false, error: message, errorCode: code });
          initPromise = null;
        }
      })();
      return initPromise;
    },

    async sendMessage(text, opts = {}) {
      const content = text.trim();
      if (!content) return;
      if (activeController) get().stop();
      stopSpeaking();

      const cid = get().conversationId;
      const seq = ++localSeq;
      const now = new Date().toISOString();
      let userId = `local-u-${seq}`;
      let assistantId = `local-a-${seq}`;
      const userMsg: ChatMessage = {
        id: userId,
        conversationId: cid ?? '',
        role: 'user',
        content,
        kind: opts.kind ?? 'chat',
        createdAt: now,
      };
      const placeholder: ChatMessage = {
        id: assistantId,
        conversationId: cid ?? '',
        role: 'assistant',
        content: '',
        thoughts: '',
        toolCalls: [],
        kind: 'chat',
        createdAt: new Date(Date.now() + 1).toISOString(),
      };

      const controller = new AbortController();
      activeController = controller;
      set((s) => ({
        messages: [...s.messages, userMsg, placeholder],
        streaming: true,
        streamingId: assistantId,
        error: null,
        errorCode: null,
        lastUserText: content,
      }));
      playSfx('send');
      if (!useUi.getState().voiceMode) useUi.getState().setOrbState('thinking');

      // Tokens e pensamentos chegam em rajadas: agrupamos em ~30 fps para não travar a interface.
      let pendingText = '';
      let pendingThought = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let firstToken = true;
      // Objeto mutável: o fluxo de controle do TS não enxerga atribuições dentro de callbacks.
      const outcome: { final: ChatMessage | null; failed: { message: string; code: ChatErrorCode } | null } = {
        final: null,
        failed: null,
      };
      const isCurrent = () => activeController === controller;

      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (!pendingText && !pendingThought) return;
        const t = pendingText;
        const th = pendingThought;
        pendingText = '';
        pendingThought = '';
        patchMessage(assistantId, (m) => ({
          ...m,
          content: m.content + t,
          thoughts: th ? (m.thoughts ?? '') + th : m.thoughts,
        }));
      };
      const scheduleFlush = () => {
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
      };

      const onEvent = (ev: ChatStreamEvent) => {
        if (!isCurrent()) return;
        switch (ev.type) {
          case 'meta': {
            const oldUser = userId;
            const oldAssistant = assistantId;
            userId = ev.userMessageId || userId;
            assistantId = ev.assistantMessageId || assistantId;
            if (userId !== oldUser) keyAliases.set(userId, oldUser);
            if (assistantId !== oldAssistant) keyAliases.set(assistantId, oldAssistant);
            set((s) => ({
              conversationId: ev.conversationId || s.conversationId,
              conversation: !ev.conversationId || s.conversation?.id === ev.conversationId ? s.conversation : null,
              streamingId: assistantId,
              messages: s.messages.map((m) =>
                m.id === oldUser
                  ? { ...m, id: userId, conversationId: ev.conversationId }
                  : m.id === oldAssistant
                    ? { ...m, id: assistantId, conversationId: ev.conversationId }
                    : m,
              ),
            }));
            if (!get().conversation && ev.conversationId) void refreshConversation(ev.conversationId);
            break;
          }
          case 'thought':
            pendingThought += ev.text;
            scheduleFlush();
            break;
          case 'token':
            pendingText += ev.text;
            if (firstToken) {
              firstToken = false;
              releaseThinking();
              flush();
            } else scheduleFlush();
            break;
          case 'tool':
            flush();
            patchMessage(assistantId, (m) => ({ ...m, toolCalls: upsertTool(m.toolCalls, ev.call) }));
            break;
          case 'done':
            flush();
            outcome.final = ev.message;
            if (ev.message.id !== assistantId) keyAliases.set(ev.message.id, messageKey(assistantId));
            set((s) => ({
              messages: s.messages.some((m) => m.id === assistantId)
                ? s.messages.map((m) => (m.id === assistantId ? ev.message : m))
                : mergeMessages(s.messages, [ev.message]),
              streamingId: ev.message.id,
              lastReply: ev.message,
            }));
            assistantId = ev.message.id;
            break;
          case 'error': {
            flush();
            const code = ev.code ?? 'internal';
            outcome.failed = {
              code,
              message: code === 'no_api_key' || code === 'quota' ? FRIENDLY[code] : ev.message || FRIENDLY[code],
            };
            break;
          }
        }
      };

      try {
        await postSSE<ChatStreamEvent>('/api/chat', { conversationId: cid ?? undefined, message: content }, onEvent, controller.signal);
      } catch (e) {
        if (isAbortError(e) || !isCurrent()) return;
        outcome.failed = describeError(e);
      } finally {
        flush();
      }

      if (!isCurrent()) return;
      activeController = null;

      if (!outcome.final && !outcome.failed) {
        outcome.failed = { code: 'internal', message: 'A resposta foi interrompida antes de terminar.' };
      }

      const f = outcome.failed;
      if (f) {
        // Mensagem do usuário sem confirmação do servidor: marca como não entregue.
        const failedId = isLocalId(userId) ? `failed-u-${seq}` : null;
        if (failedId) keyAliases.set(failedId, messageKey(userId));
        set((s) => ({
          streaming: false,
          streamingId: null,
          error: f.message,
          errorCode: f.code,
          // Remove o espaço reservado se nada chegou; mantém respostas parciais.
          messages: s.messages
            .filter((m) => m.id !== assistantId || m.content.trim() !== '' || (m.toolCalls?.length ?? 0) > 0)
            .map((m) => (failedId && m.id === userId ? { ...m, id: failedId } : m)),
        }));
        releaseThinking();
        playSfx('error');
        flashAlert();
        return;
      }

      const reply = outcome.final;
      set({ streaming: false, streamingId: null });
      releaseThinking();
      if (reply) {
        playSfx('receive');
        const shouldSpeak = opts.speak ?? Boolean(settings()?.speakInChat);
        if (shouldSpeak && reply.content.trim()) void speak(reply.content, { key: reply.id });
      }
    },

    stop() {
      const controller = activeController;
      if (!controller) return;
      activeController = null;
      controller.abort();
      const { conversationId, streamingId } = get();
      if (conversationId) {
        fetch('/api/chat/stop', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId }),
        }).catch(() => undefined);
      }
      set((s) => ({
        streaming: false,
        streamingId: null,
        messages: s.messages.filter(
          (m) => m.id !== streamingId || m.content.trim() !== '' || (m.toolCalls?.length ?? 0) > 0,
        ),
      }));
      releaseThinking();
      playSfx('stop');
    },

    async retry() {
      const text = get().lastUserText;
      if (!text || get().streaming) return;
      if (get().errorCode === 'network' && !get().initialized) {
        set({ error: null, errorCode: null });
        await get().init();
        return;
      }
      // Remove a última mensagem do usuário que não chegou ao servidor, para não duplicar.
      set((s) => {
        const last = s.messages[s.messages.length - 1];
        const drop = last && last.role === 'user' && last.content === text && last.id.startsWith('failed-') ? last.id : null;
        return { messages: drop ? s.messages.filter((m) => m.id !== drop) : s.messages, error: null, errorCode: null };
      });
      await get().sendMessage(text);
    },

    async loadConversation(id) {
      if (get().conversationId === id && get().initialized) return;
      get().stop();
      stopSpeaking();
      set({ loading: true, error: null, errorCode: null });
      try {
        const msgs = await fetchMessages(id);
        set({
          conversationId: id,
          conversation: findConversation(id),
          messages: msgs,
          hasMore: msgs.length >= PAGE_SIZE,
          loading: false,
          initialized: true,
        });
        if (!get().conversation) void refreshConversation(id);
      } catch (e) {
        const { message, code } = describeError(e);
        set({ loading: false, error: message, errorCode: code });
      }
    },

    async newConversation() {
      get().stop();
      stopSpeaking();
      try {
        const conv = await requestJson<Conversation>('/api/conversations', { method: 'POST', body: {} });
        set({
          conversationId: conv.id,
          conversation: conv,
          messages: [],
          hasMore: false,
          initialized: true,
          error: null,
          errorCode: null,
          lastReply: null,
        });
        playSfx('click');
      } catch (e) {
        const { message, code } = describeError(e);
        set({ error: message, errorCode: code });
      }
    },

    async loadOlder() {
      const { conversationId, loadingOlder, hasMore, messages } = get();
      if (!conversationId || loadingOlder || !hasMore) return;
      const oldest = messages.find((m) => !isLocalId(m.id));
      if (!oldest) return;
      set({ loadingOlder: true });
      try {
        const older = await fetchMessages(conversationId, oldest.createdAt);
        if (get().conversationId !== conversationId) return;
        set((s) => ({
          messages: mergeMessages(older, s.messages),
          hasMore: older.length >= PAGE_SIZE && older.some((m) => !s.messages.some((x) => x.id === m.id)),
          loadingOlder: false,
        }));
      } catch {
        set({ loadingOlder: false });
      }
    },

    receiveProactive(msg) {
      const { conversationId, messages, streamingId } = get();
      if (!conversationId || msg.conversationId !== conversationId) return;
      if (msg.id === streamingId) return;
      const isNew = !messages.some((m) => m.id === msg.id);
      set((s) => ({ messages: mergeMessages(s.messages, [msg]) }));
      if (!isNew || msg.role !== 'assistant') return;
      const shouldSpeak = Boolean(settings()?.speakInChat) || useUi.getState().voiceMode;
      if (shouldSpeak && msg.content.trim()) void speak(msg.content, { key: msg.id });
    },

    appendMessages(msgs) {
      const valid = msgs.filter((m): m is ChatMessage => Boolean(m && m.id));
      if (!valid.length) return;
      set((s) => {
        const cid = s.conversationId ?? valid[0].conversationId;
        const mine = valid.filter((m) => m.conversationId === cid);
        if (!mine.length) return {};
        return { conversationId: cid, messages: mergeMessages(s.messages, mine), initialized: true };
      });
    },

    clearError() {
      set({ error: null, errorCode: null });
    },
  };
});

// ─── Conversa (título) ────────────────────────────────────────────────────

function findConversation(id: string): Conversation | null {
  const list = (useData.getState() as { conversations?: unknown }).conversations;
  if (Array.isArray(list)) {
    const found = (list as Conversation[]).find((c) => c && c.id === id);
    if (found) return found;
  }
  return null;
}

async function refreshConversation(id: string): Promise<void> {
  try {
    const local = findConversation(id);
    const conv = local ?? (await requestJson<Conversation[]>('/api/conversations')).find((c) => c.id === id) ?? null;
    if (conv && useChat.getState().conversationId === id) useChat.setState({ conversation: conv });
  } catch {
    /* o título é apenas decorativo */
  }
}
