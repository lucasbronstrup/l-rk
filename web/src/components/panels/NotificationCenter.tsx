import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { BellRing, Brain, CircleAlert, CircleCheck, Handshake, Info, MessageSquare, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useData, type Toast, type ToastKind } from '@/store/data';
import { EASE_OUT_EXPO } from './parts';

const ICON: Record<ToastKind, ReactNode> = {
  info: <Info size={15} />,
  success: <CircleCheck size={15} />,
  warn: <TriangleAlert size={15} />,
  error: <CircleAlert size={15} />,
  reminder: <BellRing size={15} />,
  checkin: <Handshake size={15} />,
  memory: <Brain size={15} />,
  approval: <ShieldAlert size={15} />,
  message: <MessageSquare size={15} />,
};

const CODE: Record<ToastKind, string> = {
  info: 'INF',
  success: 'OK',
  warn: 'AVS',
  error: 'ERR',
  reminder: 'RMD',
  checkin: 'PRM',
  memory: 'MEM',
  approval: 'AUT',
  message: 'MSG',
};

const ACCENT: Record<ToastKind, { text: string; bar: string; border: string }> = {
  info: { text: 'text-red-soft', bar: 'bg-red/70', border: 'border-line-strong' },
  success: { text: 'text-ok', bar: 'bg-ok/80', border: 'border-ok/35' },
  warn: { text: 'text-warn', bar: 'bg-warn/80', border: 'border-warn/40' },
  error: { text: 'text-red-bright', bar: 'bg-red-bright', border: 'border-red/70' },
  reminder: { text: 'text-red-bright', bar: 'bg-red-bright', border: 'border-red/70' },
  checkin: { text: 'text-red-bright', bar: 'bg-red', border: 'border-red/60' },
  memory: { text: 'text-red-soft', bar: 'bg-red/70', border: 'border-line-strong' },
  approval: { text: 'text-red-bright', bar: 'bg-red-bright', border: 'border-red/70' },
  message: { text: 'text-red-bright', bar: 'bg-red', border: 'border-red/60' },
};

/** Barra de tempo + auto-fechamento, com pausa ao passar o mouse ou focar. */
function useAutoDismiss(toast: Toast, paused: boolean) {
  const remaining = useRef(toast.duration);
  const startedAt = useRef(0);
  const [bar, setBar] = useState<{ scale: number; ms: number }>({ scale: 1, ms: 0 });

  useEffect(() => {
    if (toast.duration <= 0) return;
    if (paused) {
      return;
    }
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => useData.getState().dismissToast(toast.id), remaining.current);
    // Dois quadros: primeiro fixa a escala atual sem transição, depois anima até zero.
    const raf = requestAnimationFrame(() => setBar({ scale: 0, ms: remaining.current }));
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
      setBar({ scale: remaining.current / toast.duration, ms: 0 });
    };
  }, [paused, toast.id, toast.duration]);

  return bar;
}

const ToastCard = memo(function ToastCard({ toast }: { toast: Toast }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const bar = useAutoDismiss(toast, hover || focus);
  const accent = ACCENT[toast.kind];
  const dismiss = () => useData.getState().dismissToast(toast.id);
  const urgent = toast.kind === 'error' || toast.kind === 'approval';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 48, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 48, scale: 0.98, transition: { duration: 0.2, ease: 'easeIn' } }}
      transition={{ duration: 0.38, ease: EASE_OUT_EXPO }}
      role={urgent ? 'alert' : 'status'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      }}
      className={cn('pointer-events-auto relative overflow-hidden border bg-abyss/[0.96] shadow-[0_8px_32px_rgb(0_0_0/0.6)]', accent.border)}
    >
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[2px]', accent.bar)} />
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-red/[0.06] to-transparent" />
      <div className="relative flex items-start gap-3 py-2.5 pl-3.5 pr-2">
        <span className={cn('mt-0.5 shrink-0', accent.text)} aria-hidden>
          {ICON[toast.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-hud text-[12.5px] font-bold uppercase tracking-[0.18em] text-ink">{toast.title}</p>
            <span aria-hidden className="font-mono text-[8.5px] tracking-[0.2em] text-dim">
              {CODE[toast.kind]}
            </span>
          </div>
          {toast.body && <p className="mt-0.5 line-clamp-3 break-words text-[12.5px] leading-snug text-muted">{toast.body}</p>}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                dismiss();
              }}
              className="mt-1.5 font-hud text-[11px] font-bold uppercase tracking-[0.18em] text-red-soft hover:text-red-bright focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
            >
              {toast.action.label} →
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Fechar notificação"
          className="grid h-6 w-6 shrink-0 place-items-center text-dim transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
        >
          <X size={13} />
        </button>
      </div>
      {toast.duration > 0 && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-white/[0.04]">
          <span
            className={cn('block h-full origin-left opacity-70', accent.bar)}
            style={{ transform: `scaleX(${bar.scale})`, transition: bar.ms ? `transform ${bar.ms}ms linear` : 'none' }}
          />
        </span>
      )}
    </motion.div>
  );
});

/** Pilha de notificações no canto superior direito, abaixo da barra superior. */
export function NotificationCenter() {
  const toasts = useData((s) => s.toasts);

  return createPortal(
    <section
      aria-label="Notificações"
      className="pointer-events-none fixed right-3 top-[calc(env(safe-area-inset-top)+64px)] z-[95] flex w-[min(360px,calc(100vw-1.5rem))] flex-col gap-2 sm:right-4 xl:right-6"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </section>,
    document.body,
  );
}
