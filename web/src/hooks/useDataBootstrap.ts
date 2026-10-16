import { useEffect } from 'react';
import type { ChatMessage, LarkEvent } from '@shared/types';
import { api, EVENTS_URL, UNAUTHORIZED_EVENT } from '@/lib/api';
import { truncate } from '@/lib/format';
import { playSfx } from '@/lib/sfx';
import { useChat } from '@/store/chat';
import { isLocalCreation, useData } from '@/store/data';
import { usePrefs } from '@/store/prefs';
import { useUi } from '@/store/ui';

/**
 * Inicialização dos dados + canal de eventos em tempo real (GET /api/events, SSE).
 *
 * - Carrega saúde, configurações, estatísticas, memórias, promessas, lembretes, conversas e aprovações.
 * - Mantém o EventSource vivo com reconexão exponencial, vigia de silêncio e retomada ao voltar à aba.
 * - Despacha cada evento: atualiza o store, entrega mensagens proativas ao chat, toca alertas,
 *   mostra notificações (toast e, com a aba oculta, notificação do navegador).
 * - Após conectar, pede o briefing matinal ao servidor (no máximo uma vez a cada 6 h por dispositivo).
 */

const EVENT_TYPES: LarkEvent['type'][] = [
  'hello',
  'ping',
  'message',
  'reminder_fired',
  'checkin',
  'memory',
  'commitment',
  'reminder',
  'approval_request',
  'approval_resolved',
  'conversation',
  'settings',
];

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** O servidor envia ping a cada 20 s: 50 s de silêncio = conexão zumbi (ex.: notebook dormiu). */
const SILENCE_LIMIT_MS = 50_000;
const BRIEFING_KEY = 'lark:last-briefing';
const BRIEFING_EVERY_MS = 6 * 60 * 60 * 1000;

// ─── Notificações do navegador ──────────────────────────────────────────

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Pede permissão de notificação na primeira interação do usuário (exigência dos navegadores). */
function armNotificationPermission(): () => void {
  if (!notificationsSupported() || Notification.permission !== 'default') return () => {};
  const ask = () => {
    cleanup();
    if (!usePrefs.getState().notifications || Notification.permission !== 'default') return;
    try {
      void Notification.requestPermission().catch(() => undefined);
    } catch {
      /* navegadores antigos: API baseada em callback — ignorado */
    }
  };
  const cleanup = () => {
    window.removeEventListener('pointerdown', ask, true);
    window.removeEventListener('keydown', ask, true);
  };
  window.addEventListener('pointerdown', ask, true);
  window.addEventListener('keydown', ask, true);
  return cleanup;
}

/** Notificação do sistema quando a aba está oculta (e o usuário permitiu). */
function notifyBrowser(title: string, body: string, tag: string): void {
  if (!notificationsSupported() || !usePrefs.getState().notifications) return;
  if (document.visibilityState === 'visible' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body: truncate(body, 220), tag, icon: '/icon.svg', badge: '/favicon.svg' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* alguns navegadores móveis só permitem notificações via service worker */
  }
}

// ─── Briefing matinal ───────────────────────────────────────────────────

function readStamp(): number {
  try {
    return Number(window.localStorage.getItem(BRIEFING_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function writeStamp(): void {
  try {
    window.localStorage.setItem(BRIEFING_KEY, String(Date.now()));
  } catch {
    /* armazenamento indisponível: o servidor ainda decide se gera */
  }
}

let briefingInFlight = false;

async function maybeBriefing(): Promise<void> {
  const settings = useData.getState().settings;
  if (!settings?.proactive.morningBriefing || briefingInFlight) return;
  if (Date.now() - readStamp() < BRIEFING_EVERY_MS) return;
  briefingInFlight = true;
  writeStamp();
  try {
    const conversationId = useChat.getState().conversationId ?? undefined;
    const { message } = await api.briefing({ conversationId });
    if (message) useChat.getState().receiveProactive(message);
  } catch (e) {
    console.warn('[Lärk] Briefing indisponível:', e);
  } finally {
    briefingInFlight = false;
  }
}

// ─── Despacho de eventos ────────────────────────────────────────────────

function goToChat(): void {
  const ui = useUi.getState();
  if (ui.mobileTab !== 'chat' || ui.settingsOpen || ui.conversationsOpen) {
    ui.set({ mobileTab: 'chat', settingsOpen: false, conversationsOpen: false });
  }
}

/** Ids de mensagens já anunciadas (o servidor pode publicar 'checkin' e 'message' para a mesma fala). */
const announced = new Set<string>();
function firstAnnouncement(id: string | undefined): boolean {
  if (!id) return true;
  if (announced.has(id)) return false;
  announced.add(id);
  if (announced.size > 200) announced.delete(announced.values().next().value as string);
  return true;
}

function deliverProactive(message: ChatMessage | null): void {
  if (!message) return;
  try {
    useChat.getState().receiveProactive(message);
  } catch (e) {
    console.warn('[Lärk] Falha ao entregar mensagem proativa:', e);
  }
}

function handleEvent(event: LarkEvent): void {
  const data = useData.getState();
  data.applyEvent(event);

  switch (event.type) {
    case 'message': {
      const m = event.message;
      deliverProactive(m);
      const proactive = m.role === 'assistant' && (m.kind === 'proactive' || m.kind === 'briefing');
      if (!proactive || !firstAnnouncement(m.id)) return;
      const title = m.kind === 'briefing' ? 'Briefing do dia' : 'Lärk tem algo a dizer';
      data.pushToast({
        kind: 'message',
        title,
        body: truncate(m.content, 160),
        action: { label: 'Abrir conversa', run: goToChat },
      });
      playSfx('alert');
      notifyBrowser(`Lärk — ${title}`, m.content, `msg-${m.id}`);
      return;
    }

    case 'reminder_fired': {
      deliverProactive(event.message);
      if (!firstAnnouncement(event.message?.id)) return;
      const text = event.reminder.text;
      data.pushToast({
        kind: 'reminder',
        title: 'Lembrete',
        body: text,
        key: `reminder-${event.reminder.id}`,
        action: {
          label: 'Adiar 10 min',
          run: () => void useData.getState().snoozeReminder(event.reminder.id, '10m'),
        },
      });
      playSfx('alert');
      notifyBrowser('Lärk — Lembrete', text, `rmd-${event.reminder.id}`);
      return;
    }

    case 'checkin': {
      deliverProactive(event.message);
      if (!firstAnnouncement(event.message?.id)) return;
      data.pushToast({
        kind: 'checkin',
        title: 'Cobrança de promessa',
        body: event.commitment.description,
        key: `checkin-${event.commitment.id}`,
        action: { label: 'Responder', run: goToChat },
      });
      playSfx('alert');
      notifyBrowser('Lärk — E aquela promessa?', event.message?.content || event.commitment.description, `chk-${event.commitment.id}`);
      return;
    }

    case 'memory':
      if (event.action === 'created' && event.memory.source !== 'manual' && !isLocalCreation('memory', event.memory.id)) {
        data.pushToast({ kind: 'memory', title: 'Memória registrada', body: truncate(event.memory.content, 120), duration: 3800 });
      }
      return;

    case 'commitment':
      if (event.action === 'created' && !isLocalCreation('commitment', event.commitment.id)) {
        data.pushToast({ kind: 'checkin', title: 'Promessa anotada', body: truncate(event.commitment.description, 140), duration: 5000 });
      }
      return;

    case 'reminder':
      if (event.action === 'created' && !isLocalCreation('reminder', event.reminder.id)) {
        data.pushToast({ kind: 'reminder', title: 'Lembrete agendado', body: truncate(event.reminder.text, 140), duration: 5000 });
      }
      return;

    case 'approval_request':
      useUi.getState().setOrbState('alert');
      playSfx('alert');
      notifyBrowser('Lärk — Autorização necessária', event.request.description || event.request.label, `apr-${event.request.id}`);
      return;

    case 'approval_resolved':
      if (!useData.getState().approvals.length && useUi.getState().orbState === 'alert') useUi.getState().setOrbState('idle');
      return;

    default:
      return;
  }
}

function parseEvent(raw: string, fallbackType?: string): LarkEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LarkEvent> & Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.type !== 'string' && fallbackType) (parsed as Record<string, unknown>).type = fallbackType;
    return typeof parsed.type === 'string' ? (parsed as LarkEvent) : null;
  } catch {
    return null;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function useDataBootstrap(): void {
  useEffect(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let retry = 0;
    let reconnectTimer: number | undefined;
    let watchdog: number | undefined;
    let lastEventAt = Date.now();
    let everConnected = false;
    let initial: Promise<void> = useData.getState().loadAll();

    const ui = useUi.getState();
    if (ui.connection !== 'online') ui.set({ connection: 'connecting' });

    const disarmPermission = armNotificationPermission();

    const touch = () => {
      lastEventAt = Date.now();
    };

    const setConnection = (connection: 'connecting' | 'online' | 'offline') => {
      if (useUi.getState().connection !== connection) useUi.getState().set({ connection });
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      window.clearTimeout(reconnectTimer);
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** retry) * (0.75 + Math.random() * 0.5);
      retry = Math.min(retry + 1, 10);
      reconnectTimer = window.setTimeout(connect, delay);
      // Depois de algumas falhas, verifica se o motivo é a sessão (cookie expirado) e não a rede.
      if (retry === 3) {
        void api
          .authStatus()
          .then((s) => {
            if (s.required && !s.authenticated) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
          })
          .catch(() => undefined);
      }
    };

    const onOpen = () => {
      touch();
      retry = 0;
      setConnection('online');
      if (everConnected) {
        // Reconexão: eventos podem ter sido perdidos — ressincroniza tudo.
        initial = useData.getState().loadAll();
      }
      const first = !everConnected;
      everConnected = true;
      if (first) {
        void initial.then(() => {
          if (!disposed) void maybeBriefing();
        });
      }
    };

    const onError = () => {
      if (disposed) return;
      es?.close();
      es = null;
      setConnection(everConnected || retry > 0 ? 'offline' : 'connecting');
      scheduleReconnect();
    };

    const onNamedEvent = (type: string) => (ev: MessageEvent<string>) => {
      touch();
      const parsed = parseEvent(ev.data, type);
      if (!parsed) return;
      try {
        handleEvent(parsed);
      } catch (e) {
        console.error('[Lärk] Falha ao processar evento', parsed.type, e);
      }
    };

    function connect() {
      if (disposed) return;
      window.clearTimeout(reconnectTimer);
      es?.close();
      try {
        es = new EventSource(EVENTS_URL, { withCredentials: true });
      } catch {
        onError();
        return;
      }
      es.onopen = onOpen;
      es.onerror = onError;
      // Eventos sem nome (fallback): o tipo vem no próprio JSON.
      es.onmessage = onNamedEvent('');
      for (const type of EVENT_TYPES) es.addEventListener(type, onNamedEvent(type) as EventListener);
    }

    // Vigia de silêncio: sem ping por muito tempo → reconecta.
    watchdog = window.setInterval(() => {
      if (!es || es.readyState !== EventSource.OPEN) return;
      if (Date.now() - lastEventAt > SILENCE_LIMIT_MS) {
        setConnection('connecting');
        retry = 0;
        connect();
      }
    }, 10_000);

    // Voltou para a aba ou a rede voltou: tenta já, sem esperar o backoff.
    const resume = () => {
      if (disposed || document.visibilityState !== 'visible') return;
      if (!es || es.readyState === EventSource.CLOSED) {
        retry = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(watchdog);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      disarmPermission();
      es?.close();
      es = null;
    };
  }, []);
}
