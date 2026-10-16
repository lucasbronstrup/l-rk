import { useUi } from '@/store/ui';
import { cn } from '@/lib/cn';

const isMac = () => {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
};

/** Rodapé do desktop: identificação do sistema e atalhos de teclado. */
export function StatusFooter() {
  const connection = useUi((s) => s.connection);
  const mod = isMac() ? '⌘' : 'Ctrl';

  return (
    <footer className="relative z-10 flex h-7 shrink-0 items-center justify-between gap-6 border-t border-line bg-abyss/85 px-6 font-mono text-[9.5px] uppercase tracking-[0.24em] text-dim">
      <span className="flex min-w-0 items-center gap-3 truncate">
        <span className="text-red/70">LRK//NÚCLEO</span>
        <span aria-hidden>·</span>
        <span className="truncate">Consciência do sistema hospedeiro</span>
        <span aria-hidden>·</span>
        <span className={cn(connection === 'online' ? 'text-muted' : connection === 'offline' ? 'text-red-soft' : 'text-warn')}>
          SYS//{connection === 'online' ? 'ONLINE' : connection === 'offline' ? 'SEM LINK' : 'SINCRONIZANDO'}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-4" aria-label="Atalhos de teclado">
        <span>
          <kbd className="kbd">{mod}</kbd> <kbd className="kbd">K</kbd> <span className="ml-1">Chat</span>
        </span>
        <span>
          <kbd className="kbd">F2</kbd> <span className="ml-1">Voz</span>
        </span>
        <span>
          <kbd className="kbd">{mod}</kbd> <kbd className="kbd">,</kbd> <span className="ml-1">Ajustes</span>
        </span>
        <span>
          <kbd className="kbd">Esc</kbd> <span className="ml-1">Fechar</span>
        </span>
      </span>
    </footer>
  );
}
