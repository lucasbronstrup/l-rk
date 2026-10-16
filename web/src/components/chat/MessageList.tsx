import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import { messageKey, useChat } from '@/store/chat';
import { useData } from '@/store/data';
import { cn } from '@/lib/cn';
import { MessageBubble } from './MessageBubble';
import { dayKey, dayLabel } from './format';

const BOTTOM_SLACK = 80;

/**
 * Lista de mensagens com rolagem inteligente:
 *  - fixa no fim enquanto o usuário está no fim (inclusive durante o streaming);
 *  - não puxa a tela se ele rolou para cima — mostra "novas mensagens";
 *  - carrega mensagens antigas ao chegar ao topo, preservando a posição.
 */
export function MessageList() {
  const messages = useChat((s) => s.messages);
  const streamingId = useChat((s) => s.streamingId);
  const conversationId = useChat((s) => s.conversationId);
  const hasMore = useChat((s) => s.hasMore);
  const loadingOlder = useChat((s) => s.loadingOlder);
  const settings = useData((s) => s.settings);

  const showThoughts = settings?.showThoughts ?? true;
  const userLabel = settings?.userName?.trim() || 'Você';
  const timeZone = settings?.timezone || undefined;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const ready = useRef(false);
  const prev = useRef<{ first: string | null; last: string | null; count: number; height: number; conv: string | null }>({
    first: null,
    last: null,
    count: 0,
    height: 0,
    conv: null,
  });
  const [unread, setUnread] = useState(0);
  const [far, setFar] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : behavior });
    atBottom.current = true;
    setUnread(0);
    setFar(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = dist < BOTTOM_SLACK;
    if (atBottom.current) setUnread(0);
    setFar(dist > el.clientHeight * 0.75);
  }, []);

  // Posicionamento após cada mudança na lista (antes da pintura, sem "pulos").
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const p = prev.current;
    const first = messages.length ? messageKey(messages[0].id) : null;
    const lastMsg = messages[messages.length - 1];
    const last = lastMsg ? messageKey(lastMsg.id) : null;

    if (p.conv !== conversationId) {
      ready.current = false;
      setUnread(0);
    }

    if (!ready.current) {
      if (messages.length) {
        el.scrollTop = el.scrollHeight;
        atBottom.current = true;
        // Só depois do primeiro posicionamento o sentinela do topo pode carregar antigas.
        requestAnimationFrame(() => {
          ready.current = true;
        });
      }
    } else if (first !== p.first && last === p.last && messages.length > p.count) {
      // Mensagens antigas inseridas acima: mantém o que estava na tela.
      el.scrollTop += el.scrollHeight - p.height;
    } else if (last !== p.last && lastMsg) {
      if (lastMsg.role === 'user' || atBottom.current) scrollToBottom('smooth');
      else setUnread((n) => n + 1);
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }

    prev.current = { first, last, count: messages.length, height: el.scrollHeight, conv: conversationId };
  }, [messages, conversationId, scrollToBottom]);

  // Conteúdo que cresce sozinho (raciocínio abrindo, imagens carregando) mantém o fim visível.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (ready.current && atBottom.current) el.scrollTop = el.scrollHeight;
      prev.current.height = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Sentinela no topo: carrega mensagens antigas. Recriado a cada carga para reavaliar a interseção.
  useEffect(() => {
    const root = scrollRef.current;
    const target = topRef.current;
    if (!root || !target || !hasMore || loadingOlder || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && ready.current) void useChat.getState().loadOlder();
      },
      { root, rootMargin: '320px 0px 0px 0px' },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [hasMore, loadingOlder, conversationId]);

  const showJump = unread > 0 || far;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none]"
        role="region"
        aria-label="Histórico da conversa"
        tabIndex={0}
      >
        <div ref={contentRef} className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 pb-6 pt-4 sm:px-6 lg:px-8">
          <div ref={topRef} aria-hidden className="h-px w-full" />
          {loadingOlder && (
            <div className="flex items-center justify-center gap-2 py-2 font-mono text-[10px] tracking-[0.24em] text-muted" role="status">
              <LoaderCircle size={12} className="animate-spin text-red" aria-hidden />
              RECUPERANDO REGISTROS ANTERIORES
            </div>
          )}
          {!hasMore && messages.length > 0 && (
            <div className="flex items-center gap-3 pt-2 font-mono text-[10px] tracking-[0.28em] text-muted">
              <span aria-hidden className="h-px w-6 bg-line-strong" />
              INÍCIO DO REGISTRO
              <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
            </div>
          )}

          {messages.map((m, i) => {
            const key = messageKey(m.id);
            const dk = dayKey(m.createdAt, timeZone);
            const prevDk = i > 0 ? dayKey(messages[i - 1].createdAt, timeZone) : null;
            return (
              <Fragment key={key}>
                {dk !== prevDk && <DaySeparator label={dayLabel(m.createdAt, timeZone)} />}
                <MessageBubble
                  message={m}
                  streaming={m.id === streamingId}
                  showThoughts={showThoughts}
                  userLabel={userLabel}
                  timeZone={timeZone}
                />
              </Fragment>
            );
          })}
        </div>
      </div>

      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            key="jump"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            onClick={() => scrollToBottom('smooth')}
            className={cn(
              'absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-2 border px-3 py-1.5 font-hud text-[11px] font-semibold uppercase tracking-[0.2em] backdrop-blur-md transition-colors',
              unread > 0
                ? 'border-red/60 bg-red/15 text-red-bright shadow-glow-sm hover:bg-red/25'
                : 'border-line-strong bg-abyss/80 text-muted hover:text-ink',
            )}
          >
            <ArrowDown size={13} aria-hidden />
            {unread > 0 ? `Novas mensagens · ${unread}` : 'Mais recentes'}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-transparent to-line" />
      <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-gradient-to-l from-transparent to-line" />
    </div>
  );
}
