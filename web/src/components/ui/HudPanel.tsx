import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface HudPanelProps {
  title?: string;
  /** Código curto exibido no canto (ex.: "MEM-01"). */
  code?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/** Painel com cantos em colchete, estilo HUD. Base visual de toda a interface. */
export function HudPanel({ title, code, icon, actions, className, bodyClassName, children }: HudPanelProps) {
  return (
    <section
      className={cn(
        'hud-panel relative flex min-h-0 flex-col border border-line bg-surface/70 backdrop-blur-md',
        className,
      )}
    >
      <span aria-hidden className="pointer-events-none absolute -left-px -top-px h-3 w-3 border-l-2 border-t-2 border-red" />
      <span aria-hidden className="pointer-events-none absolute -right-px -top-px h-3 w-3 border-r-2 border-t-2 border-red" />
      <span aria-hidden className="pointer-events-none absolute -bottom-px -left-px h-3 w-3 border-b-2 border-l-2 border-red" />
      <span aria-hidden className="pointer-events-none absolute -bottom-px -right-px h-3 w-3 border-b-2 border-r-2 border-red" />
      {(title || actions) && (
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          {icon && <span className="text-red">{icon}</span>}
          {title && (
            <h2 className="font-hud text-[13px] font-semibold uppercase tracking-[0.22em] text-ink">{title}</h2>
          )}
          {code && <span className="font-mono text-[10px] tracking-widest text-dim">{code}</span>}
          <div className="ml-auto flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}
