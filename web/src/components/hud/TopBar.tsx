import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AudioLines, Cpu, Menu, MessagesSquare, Mic, Monitor, Server, Settings, X } from 'lucide-react';
import { useUi } from '@/store/ui';
import { useData } from '@/store/data';
import { playSfx } from '@/lib/sfx';
import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui';
import { LarkLogo } from './LarkLogo';
import { Clock } from './Clock';
import { useBreakpoint } from './hooks';

type Connection = 'connecting' | 'online' | 'offline';

const CONNECTION_LABEL: Record<Connection, string> = {
  online: 'Online',
  connecting: 'Conectando',
  offline: 'Offline',
};

/** "models/gemini-2.5-flash" → "gemini-2.5-flash". */
const shortModel = (id?: string | null) => (id ? id.replace(/^models\//, '') : null);

// ─── Dados de status (seletores com fallback enquanto o servidor responde) ──

function useStatus() {
  const connection = useUi((s) => s.connection);
  const health = useData((s) => s.health);
  const settings = useData((s) => s.settings);

  const model = health?.mock ? 'modo demonstração' : shortModel(health?.activeModels?.chat);
  const noKey = !!health && !health.mock && !health.hasApiKey;

  return {
    connection,
    model: noKey ? 'sem chave da API' : (model ?? 'automático'),
    modelWarn: noKey,
    computerOn: settings?.computer?.enabled ?? null,
    host: health?.hostname ?? null,
    version: health?.version ? health.version.split('.').slice(0, 2).join('.') : '0.1',
    timeZone: settings?.timezone,
  };
}

// ─── Peças ──────────────────────────────────────────────────────────────

function StatusDot({ connection, className }: { connection: Connection; className?: string }) {
  return (
    <span className={cn('relative inline-flex h-2 w-2 shrink-0', className)} aria-hidden>
      {connection === 'online' && <span className="lark-ping absolute inset-0 rounded-full bg-red-bright" />}
      <span
        className={cn(
          'relative inline-flex h-2 w-2 rounded-full',
          connection === 'online' && 'bg-red-bright shadow-[0_0_8px_rgb(255_30_60/0.9)]',
          connection === 'connecting' && 'lark-blink bg-warn',
          connection === 'offline' && 'bg-dim',
        )}
      />
    </span>
  );
}

interface ChipProps {
  icon?: ReactNode;
  label: string;
  children: ReactNode;
  title?: string;
  className?: string;
}

function Chip({ icon, label, children, title, className }: ChipProps) {
  return (
    <div
      title={title}
      className={cn('flex h-7 min-w-0 items-center gap-2 border border-line-neutral bg-white/[0.025] px-2.5', className)}
    >
      {icon && (
        <span className="shrink-0 text-red/80" aria-hidden>
          {icon}
        </span>
      )}
      <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.22em] text-dim">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

function VoiceToggle({ active, onToggle, withLabel }: { active: boolean; onToggle: () => void; withLabel: boolean }) {
  const label = active ? 'Encerrar modo de voz' : 'Ativar modo de voz';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={label}
      title={`${label} (F2)`}
      className={cn(
        'relative inline-flex h-9 shrink-0 items-center justify-center gap-2 border transition-all duration-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-red',
        withLabel ? 'px-3' : 'w-9',
        active
          ? 'border-red bg-red/15 text-red-bright shadow-glow-sm'
          : 'border-line-strong text-ink hover:border-red hover:bg-red/10 hover:text-white',
      )}
    >
      {active ? <AudioLines size={16} className="animate-pulse-red" /> : <Mic size={16} />}
      {withLabel && (
        <span className="font-hud text-[11px] font-semibold uppercase tracking-[0.2em]">{active ? 'Voz ativa' : 'Voz'}</span>
      )}
    </button>
  );
}

// ─── Menu do celular ────────────────────────────────────────────────────

function MobileMenu({ status }: { status: ReturnType<typeof useStatus> }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    // Foco no primeiro item ao abrir, para navegação por teclado.
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (patch: { conversationsOpen?: boolean; settingsOpen?: boolean }) => {
    playSfx('click');
    setOpen(false);
    useUi.getState().set(patch);
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const itemClass =
    'flex w-full items-center gap-3 px-4 py-3 text-left font-hud text-sm font-semibold uppercase tracking-[0.18em] text-ink transition-colors hover:bg-red/10 focus-visible:bg-red/10 focus-visible:outline-none';

  return (
    <div className="relative">
      <IconButton
        ref={buttonRef}
        label={open ? 'Fechar menu' : 'Abrir menu'}
        active={open}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X size={16} /> : <Menu size={16} />}
      </IconButton>

      <AnimatePresence>
        {/* Sem backdrop-filter aqui: aninhado no do cabeçalho, o Chrome deixa o fundo transparente. */}
        {open && (
          <motion.div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Menu do Lärk"
            onKeyDown={onMenuKey}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="absolute right-0 top-[calc(100%+10px)] z-40 w-[min(18rem,calc(100vw-1.5rem))] origin-top-right border border-line-strong bg-abyss shadow-glow-lg"
          >
            <span aria-hidden className="pointer-events-none absolute -left-px -top-px h-2.5 w-2.5 border-l-2 border-t-2 border-red" />
            <span aria-hidden className="pointer-events-none absolute -bottom-px -right-px h-2.5 w-2.5 border-b-2 border-r-2 border-red" />
            <button type="button" role="menuitem" className={itemClass} onClick={() => choose({ conversationsOpen: true })}>
              <MessagesSquare size={16} className="text-red" aria-hidden />
              Conversas
            </button>
            <button type="button" role="menuitem" className={itemClass} onClick={() => choose({ settingsOpen: true })}>
              <Settings size={16} className="text-red" aria-hidden />
              Configurações
            </button>

            <div className="border-t border-line px-4 py-3">
              <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.3em] text-dim">Status // SYS</p>
              <dl className="space-y-1.5 text-[12px]">
                <MenuRow label="Conexão">
                  <span className="inline-flex items-center gap-2">
                    <StatusDot connection={status.connection} />
                    {CONNECTION_LABEL[status.connection]}
                  </span>
                </MenuRow>
                <MenuRow label="Modelo">
                  <span className={cn('font-mono text-[11px]', status.modelWarn && 'text-warn')}>{status.model}</span>
                </MenuRow>
                <MenuRow label="Acesso ao PC">
                  <span className={status.computerOn ? 'text-red-bright' : 'text-muted'}>
                    {status.computerOn === null ? '—' : status.computerOn ? 'Ativo' : 'Desligado'}
                  </span>
                </MenuRow>
                {status.host && (
                  <MenuRow label="Host">
                    <span className="font-mono text-[11px]">{status.host}</span>
                  </MenuRow>
                )}
              </dl>
            </div>
            <div className="border-t border-line px-4 py-3">
              <Clock timeZone={status.timeZone} align="left" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="font-hud font-medium uppercase tracking-[0.16em] text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-ink">{children}</dd>
    </div>
  );
}

// ─── Barra superior ─────────────────────────────────────────────────────

/**
 * Barra superior da HUD: marca, chips de status, relógio e ações principais.
 * No celular fica compacta (logo, status, voz e menu).
 */
export function TopBar() {
  const bp = useBreakpoint();
  const status = useStatus();
  const voiceMode = useUi((s) => s.voiceMode);
  const conversationsOpen = useUi((s) => s.conversationsOpen);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const compact = bp === 'mobile';

  const toggleVoice = () => {
    playSfx('click');
    const ui = useUi.getState();
    ui.set({ voiceMode: !ui.voiceMode });
  };
  const open = (patch: { conversationsOpen?: boolean; settingsOpen?: boolean }) => {
    playSfx('click');
    useUi.getState().set(patch);
  };

  return (
    <header className="safe-top relative z-30 shrink-0 border-b border-line bg-abyss/60 backdrop-blur-md">
      <div
        className={cn(
          'flex items-center gap-3 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] md:gap-4 md:px-4 xl:px-6',
          compact ? 'h-[52px]' : 'h-14',
        )}
      >
        {/* Marca */}
        <div className="flex min-w-0 items-center gap-3">
          <LarkLogo size="sm" className="text-glow-soft" />
          {compact ? (
            <StatusDot connection={status.connection} className="ml-1" />
          ) : (
            <>
              <span aria-hidden className="hidden h-7 w-px bg-line-strong xl:block" />
              <div className="hidden min-w-0 flex-col leading-tight xl:flex">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.28em] text-muted">Sistema pessoal // v{status.version}</span>
                <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-dim">
                  SYS//{status.connection === 'online' ? 'ONLINE' : status.connection === 'connecting' ? 'SINC' : 'OFFLINE'}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Chips de status */}
        {!compact && (
          <div className="ml-2 hidden min-w-0 items-center gap-2 md:flex" aria-label="Status do sistema" role="group">
            <Chip
              label="Link"
              title={`Conexão com o servidor: ${CONNECTION_LABEL[status.connection]}`}
              icon={<StatusDot connection={status.connection} />}
            >
              <span
                className={cn(
                  'font-hud text-[12px] font-semibold uppercase tracking-[0.14em]',
                  status.connection === 'offline' ? 'text-red-soft' : 'text-ink',
                )}
              >
                {CONNECTION_LABEL[status.connection]}
              </span>
            </Chip>
            <Chip label="Modelo" icon={<Cpu size={12} />} title="Modelo de linguagem ativo" className="hidden max-w-[13rem] lg:flex">
              <span className={cn('font-mono text-[11px]', status.modelWarn ? 'text-warn' : 'text-ink')}>{status.model}</span>
            </Chip>
            <Chip label="Acesso" icon={<Monitor size={12} />} title="Acesso ao computador" className="hidden lg:flex">
              <span
                className={cn(
                  'font-hud text-[12px] font-bold uppercase tracking-[0.16em]',
                  status.computerOn ? 'text-red-bright text-glow-soft' : 'text-dim',
                )}
              >
                {status.computerOn === null ? '—' : status.computerOn ? 'ON' : 'OFF'}
              </span>
            </Chip>
            {status.host && (
              <Chip label="Host" icon={<Server size={12} />} title={`Computador hospedeiro: ${status.host}`} className="hidden max-w-[13rem] 2xl:flex">
                <span className="font-mono text-[11px] text-ink">{status.host}</span>
              </Chip>
            )}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2 md:gap-3">
          {!compact && (
            <>
              <Clock timeZone={status.timeZone} date={bp === 'desktop' ? 'responsive' : 'none'} className="hidden md:flex" />
              <span aria-hidden className="hidden h-8 w-px bg-line md:block" />
              <IconButton label="Conversas" active={conversationsOpen} onClick={() => open({ conversationsOpen: true })}>
                <MessagesSquare size={16} />
              </IconButton>
            </>
          )}
          <VoiceToggle active={voiceMode} onToggle={toggleVoice} withLabel={bp === 'desktop'} />
          {compact ? (
            <MobileMenu status={status} />
          ) : (
            <IconButton label="Configurações" active={settingsOpen} onClick={() => open({ settingsOpen: true })}>
              <Settings size={16} />
            </IconButton>
          )}
        </div>
      </div>

      {/* Filete luminoso inferior */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgb(255 30 60 / 0.75) 50%, transparent)' }}
      />
      <span aria-hidden className="pointer-events-none absolute -bottom-[3px] left-1/2 h-[5px] w-16 -translate-x-1/2 bg-red/80 shadow-glow-sm [clip-path:polygon(0_0,100%_0,88%_100%,12%_100%)]" />
    </header>
  );
}
