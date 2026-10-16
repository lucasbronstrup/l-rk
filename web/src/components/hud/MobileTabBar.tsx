import { motion } from 'motion/react';
import { Brain, Cpu, ListChecks, MessageSquareText } from 'lucide-react';
import { useUi, type MobileTab } from '@/store/ui';
import { playSfx } from '@/lib/sfx';
import { cn } from '@/lib/cn';

const TABS: { id: MobileTab; label: string; icon: typeof Brain }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'memory', label: 'Memória', icon: Brain },
  { id: 'protocols', label: 'Protocolos', icon: ListChecks },
  { id: 'system', label: 'Sistema', icon: Cpu },
];

/** Barra de abas inferior do celular (respeita a área segura do aparelho). */
export function MobileTabBar() {
  const active = useUi((s) => s.mobileTab);

  const select = (id: MobileTab) => {
    if (id === active) return;
    playSfx('click');
    useUi.getState().set({ mobileTab: id });
  };

  return (
    <nav
      aria-label="Navegação principal"
      className="safe-bottom safe-x relative z-20 shrink-0 border-t border-line bg-abyss/95"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-px h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgb(255 30 60 / 0.6) 50%, transparent)' }}
      />
      <ul className="grid h-14 grid-cols-4">
        {TABS.map(({ id, label, icon: Icon }) => {
          const selected = id === active;
          return (
            <li key={id} className="relative">
              <button
                type="button"
                onClick={() => select(id)}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                  'flex h-full w-full flex-col items-center justify-center gap-1 transition-colors focus-visible:-outline-offset-2',
                  selected ? 'text-ink' : 'text-muted active:text-ink',
                )}
              >
                <Icon size={18} className={selected ? 'text-red-bright drop-shadow-[0_0_6px_rgb(255_30_60/0.7)]' : undefined} aria-hidden />
                <span className="font-hud text-[10.5px] font-semibold uppercase tracking-[0.16em]">{label}</span>
              </button>
              {selected && (
                <motion.span
                  layoutId="lark-mobile-tab"
                  aria-hidden
                  className="absolute inset-x-5 top-0 h-[2px] bg-red shadow-glow-sm"
                  transition={{ type: 'spring', stiffness: 520, damping: 42 }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
