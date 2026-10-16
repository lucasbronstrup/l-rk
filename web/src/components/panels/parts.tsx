import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Check, RotateCcw, Trash, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { HudButton, IconButton } from '@/components/ui';

/**
 * Peças compartilhadas pelos painéis do W3: relógio compartilhado, estados vazios/carregando/erro,
 * campos de formulário no padrão HUD, confirmação em dois toques, medidor de importância
 * e um diálogo acessível (portal, foco preso, Esc só na camada do topo, animação).
 */

export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

// ─── Relógio compartilhado ──────────────────────────────────────────────

const tickListeners = new Map<number, Set<() => void>>();
const tickTimers = new Map<number, number>();
const tickValues = new Map<number, number>();

function subscribeTick(interval: number, cb: () => void): () => void {
  let set = tickListeners.get(interval);
  if (!set) {
    set = new Set();
    tickListeners.set(interval, set);
  }
  set.add(cb);
  if (!tickTimers.has(interval)) {
    const fire = () => {
      tickValues.set(interval, Date.now());
      tickListeners.get(interval)?.forEach((fn) => fn());
    };
    // Alinha ao próximo segundo cheio: contagens regressivas viram juntas, sem "tremer".
    const align = interval - (Date.now() % interval);
    const start = window.setTimeout(() => {
      fire();
      tickTimers.set(interval, window.setInterval(fire, interval));
    }, align);
    tickTimers.set(interval, start);
  }
  return () => {
    const s = tickListeners.get(interval);
    s?.delete(cb);
    if (s && s.size === 0) {
      const t = tickTimers.get(interval);
      if (t !== undefined) {
        window.clearTimeout(t);
        window.clearInterval(t);
      }
      tickTimers.delete(interval);
      tickListeners.delete(interval);
    }
  };
}

function readTick(interval: number): number {
  let v = tickValues.get(interval);
  if (v === undefined || Date.now() - v > interval * 2) {
    v = Date.now();
    tickValues.set(interval, v);
  }
  return v;
}

/** Instante atual que re-renderiza a cada `intervalMs` (um único timer por intervalo para toda a interface). */
export function useNow(intervalMs = 1000): number {
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribeTick(intervalMs, cb), [intervalMs]),
    () => readTick(intervalMs),
    () => Date.now(),
  );
}

// ─── Estados de painel ──────────────────────────────────────────────────

export function PanelEmpty({ icon, title, quote, action }: { icon: ReactNode; title: string; quote?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center px-6 py-8 text-center">
      <div className="relative mb-4 grid h-14 w-14 place-items-center text-red/85">
        <span aria-hidden className="absolute inset-0 bg-red/[0.05] shadow-[inset_0_0_18px_rgb(255_30_60/0.12)]" />
        <span aria-hidden className="absolute -left-1 -top-1 h-3 w-3 border-l border-t border-red/70" />
        <span aria-hidden className="absolute -right-1 -top-1 h-3 w-3 border-r border-t border-red/70" />
        <span aria-hidden className="absolute -bottom-1 -left-1 h-3 w-3 border-b border-l border-red/70" />
        <span aria-hidden className="absolute -bottom-1 -right-1 h-3 w-3 border-b border-r border-red/70" />
        <span className="relative">{icon}</span>
      </div>
      <p className="font-hud text-[13px] font-semibold uppercase tracking-[0.22em] text-ink">{title}</p>
      {quote && <p className="mt-2 max-w-[30ch] text-[13px] italic leading-relaxed text-muted">{quote}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PanelSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3 p-3', className)} aria-busy="true" aria-label="Carregando">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2 border-l-2 border-line py-1 pl-3 motion-safe:animate-pulse" style={{ animationDelay: `${i * 120}ms` }}>
          <div className="h-3 bg-white/[0.06]" style={{ width: `${88 - ((i * 17) % 35)}%` }} />
          <div className="h-2 w-1/3 bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex h-full min-h-[160px] flex-col items-center justify-center gap-3 p-6 text-center">
      <TriangleAlert size={20} className="text-red-bright" aria-hidden />
      <p className="max-w-[32ch] text-[13px] text-muted">{message}</p>
      {onRetry && (
        <HudButton size="sm" variant="outline" icon={<RotateCcw size={13} />} onClick={onRetry}>
          Tentar de novo
        </HudButton>
      )}
    </div>
  );
}

/** Rótulo de seção: "PENDENTES ── 3". */
export function SectionLabel({ children, count, className, action }: { children: ReactNode; count?: number; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('flex items-center gap-2 px-3 pb-1.5 pt-3', className)}>
      <span className="font-hud text-[11px] font-semibold uppercase tracking-[0.24em] text-muted">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
      {count !== undefined && <span className="tabular font-mono text-[10px] text-dim">{String(count).padStart(2, '0')}</span>}
      {action}
    </div>
  );
}

/** Código técnico pequeno em mono (ex.: "SYS//ONLINE"). */
export function TechCode({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[9.5px] uppercase tracking-[0.24em] text-dim', className)}>{children}</span>;
}

// ─── Campos de formulário ───────────────────────────────────────────────

export function FieldLabel({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="block font-hud text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
        {children}
      </label>
      {hint && <span className="text-[11px] text-dim">{hint}</span>}
    </div>
  );
}

const controlBase =
  'w-full border border-line-neutral bg-black/40 px-3 font-sans text-sm text-ink placeholder:text-dim transition-colors focus:border-red focus:shadow-glow-sm focus:outline-none disabled:opacity-50';

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, rows = 3, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={cn(controlBase, 'resize-y py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(controlBase, 'h-10 appearance-none pr-8 [&>option]:bg-abyss', className)} {...rest}>
        {children}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rotate-45 border-b border-r border-red" />
    </div>
  );
});

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(controlBase, 'h-10', className)} {...rest} />;
});

// ─── Importância 1–5 ────────────────────────────────────────────────────

const IMPORTANCE_LABEL = ['', 'Trivial', 'Útil', 'Relevante', 'Importante', 'Essencial'];

export function ImportanceMeter({ value, onChange, size = 'sm' }: { value: number; onChange?: (v: number) => void; size?: 'sm' | 'md' }) {
  const v = Math.max(1, Math.min(5, Math.round(value || 1)));
  const dot = size === 'md' ? 'h-2.5 w-2.5' : 'h-1.5 w-1.5';
  if (!onChange) {
    return (
      <span className="inline-flex items-center gap-[3px]" role="img" aria-label={`Importância ${v} de 5: ${IMPORTANCE_LABEL[v]}`} title={`Importância: ${IMPORTANCE_LABEL[v]}`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={cn(dot, i <= v ? (v >= 4 ? 'bg-red-bright shadow-[0_0_6px_rgb(255_30_60/0.7)]' : 'bg-red') : 'bg-white/10')}
          />
        ))}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-3" role="radiogroup" aria-label="Importância">
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={i === v}
            aria-label={`${i} — ${IMPORTANCE_LABEL[i]}`}
            onClick={() => onChange(i)}
            className="grid h-7 w-6 place-items-center focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
          >
            <span className={cn('h-2.5 w-2.5 transition-colors', i <= v ? 'bg-red-bright shadow-glow-sm' : 'bg-white/10 hover:bg-white/25')} />
          </button>
        ))}
      </div>
      <span className="font-hud text-xs font-semibold uppercase tracking-[0.16em] text-muted">{IMPORTANCE_LABEL[v]}</span>
    </div>
  );
}

// ─── Confirmação em dois toques ─────────────────────────────────────────

/** Botão de apagar que pede um segundo clique (3 s) antes de agir. */
export function ConfirmDelete({ onConfirm, label = 'Apagar', size = 'sm' }: { onConfirm: () => void; label?: string; size?: 'sm' | 'md' }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return armed ? (
    <button
      type="button"
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 border border-red bg-red/20 px-2 font-hud text-[11px] font-bold uppercase tracking-[0.14em] text-red-bright shadow-glow-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-red',
        size === 'sm' ? 'h-7' : 'h-9',
      )}
      aria-label={`Confirmar: ${label.toLowerCase()}`}
      autoFocus
    >
      <Check size={12} aria-hidden /> Confirmar
    </button>
  ) : (
    <IconButton label={label} size={size} onClick={() => setArmed(true)} className="hover:border-red/60 hover:text-red-bright">
      <Trash size={13} />
    </IconButton>
  );
}

// ─── Diálogo acessível ──────────────────────────────────────────────────

interface Layer {
  id: number;
  onEscape?: () => void;
}
const layers: Layer[] = [];
let layerSeq = 0;

function onLayerKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing) return;
  const top = layers[layers.length - 1];
  if (!top?.onEscape) return;
  e.preventDefault();
  e.stopPropagation();
  top.onEscape();
}

function pushLayer(layer: Layer) {
  if (!layers.length) window.addEventListener('keydown', onLayerKey, true);
  layers.push(layer);
}

function removeLayer(id: number) {
  const i = layers.findIndex((l) => l.id === id);
  if (i !== -1) layers.splice(i, 1);
  if (!layers.length) window.removeEventListener('keydown', onLayerKey, true);
}

/** true se a camada (diálogo) é a de cima — usado para atalhos exclusivos (Enter na aprovação). */
export function isTopLayer(id: number): boolean {
  return layers[layers.length - 1]?.id === id;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface DialogProps {
  open: boolean;
  /** Chamado por Esc (se camada do topo) e pelo clique no fundo. */
  onClose: () => void;
  label: string;
  role?: 'dialog' | 'alertdialog';
  /** Classe de empilhamento (z-index) da sobreposição. */
  zClass?: string;
  className?: string;
  /** Posição: centro (padrão) ou gaveta à esquerda. */
  placement?: 'center' | 'left';
  closeOnBackdrop?: boolean;
  /** Foco inicial: seletor CSS dentro do diálogo. */
  initialFocus?: string;
  /** Recebe o id da camada (para isTopLayer). */
  onLayer?: (id: number) => void;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  label,
  role = 'dialog',
  zClass = 'z-50',
  className,
  placement = 'center',
  closeOnBackdrop = true,
  initialFocus,
  onLayer,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const layerRef = useRef<number>(0);
  const onLayerRef = useRef(onLayer);
  onLayerRef.current = onLayer;

  useEffect(() => {
    if (!open) return;
    const id = ++layerSeq;
    layerRef.current = id;
    onLayerRef.current?.(id);
    pushLayer({ id, onEscape: () => closeRef.current() });
    const previous = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const root = panelRef.current;
      if (!root) return;
      const target = (initialFocus && root.querySelector<HTMLElement>(initialFocus)) || root.querySelector<HTMLElement>(FOCUSABLE) || root;
      target.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      removeLayer(id);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open, initialFocus]);

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const root = panelRef.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const left = placement === 'left';

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="dialog"
          className={cn('fixed inset-0 flex', left ? 'items-stretch justify-start' : 'items-center justify-center p-3 sm:p-6', zClass)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div
            aria-hidden
            className="absolute inset-0 bg-void/80 [background-image:radial-gradient(ellipse_at_center,rgb(255_30_60/0.07),transparent_65%)]"
            onClick={closeOnBackdrop ? () => closeRef.current() : undefined}
          />
          <motion.div
            ref={panelRef}
            role={role}
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={trapTab}
            className={cn('relative flex min-h-0 outline-none', left ? 'h-full' : 'max-h-full w-full', className)}
            initial={left ? { x: '-100%' } : { opacity: 0, y: 14, scale: 0.985 }}
            animate={left ? { x: 0 } : { opacity: 1, y: 0, scale: 1 }}
            exit={left ? { x: '-100%' } : { opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: left ? 0.32 : 0.26, ease: EASE_OUT_EXPO }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Id estável para associar rótulos a campos. */
export function useFieldId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}
