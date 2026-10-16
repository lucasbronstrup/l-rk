import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { playSfx } from '@/lib/sfx';
import { cn } from '@/lib/cn';
import { PanelSlot } from './PanelSlot';

export interface DockTab {
  id: string;
  label: string;
  icon: ReactNode;
  render: () => ReactNode;
}

interface TabbedDockProps {
  tabs: DockTab[];
  /** Chave para lembrar a aba escolhida durante a sessão. */
  storageKey?: string;
  className?: string;
}

function readTab(key: string | undefined, fallback: string): string {
  if (!key) return fallback;
  try {
    return window.sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Coluna lateral do tablet: painéis em abas (Memória, Promessas, Lembretes, Sistema),
 * com navegação por setas, Home e End, conforme o padrão WAI-ARIA de abas.
 */
export function TabbedDock({ tabs, storageKey, className }: TabbedDockProps) {
  const baseId = useId();
  const [active, setActive] = useState(() => {
    const saved = readTab(storageKey, tabs[0]?.id ?? '');
    return tabs.some((t) => t.id === saved) ? saved : (tabs[0]?.id ?? '');
  });
  const listRef = useRef<HTMLDivElement>(null);

  const select = (id: string, focus = false) => {
    if (id !== active) playSfx('click');
    setActive(id);
    if (storageKey) {
      try {
        window.sessionStorage.setItem(storageKey, id);
      } catch {
        // Sem armazenamento de sessão: a aba só não será lembrada.
      }
    }
    if (focus) listRef.current?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next]!.id, true);
  };

  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Painéis do sistema"
        onKeyDown={onKeyDown}
        className="relative grid shrink-0 border border-line bg-surface/90"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === current?.id;
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              data-tab={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.id)}
              className={cn(
                'relative flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 px-1 transition-colors focus-visible:-outline-offset-2',
                selected ? 'bg-red/[0.07] text-ink' : 'text-muted hover:bg-white/[0.03] hover:text-ink',
              )}
            >
              <span className={cn('shrink-0', selected ? 'text-red-bright' : 'text-dim')} aria-hidden>
                {tab.icon}
              </span>
              <span className="w-full truncate text-center font-hud text-[10.5px] font-semibold uppercase tracking-[0.16em]">{tab.label}</span>
              {selected && (
                <motion.span
                  layoutId={`${baseId}-indicator`}
                  aria-hidden
                  className="absolute inset-x-2 -bottom-px h-[2px] bg-red shadow-glow-sm"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
            </button>
          );
        })}
      </div>

      {current && (
        <div role="tabpanel" id={panelId(current.id)} aria-labelledby={tabId(current.id)} className="flex min-h-0 flex-1 flex-col">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={current.id}
              className="flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <PanelSlot name={current.label} className="flex-1">
                {current.render()}
              </PanelSlot>
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
