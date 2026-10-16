import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { Info, Keyboard, Mic, MicOff, PhoneOff, TriangleAlert, X } from 'lucide-react';
import { ReactorOrb } from '@/components/hud/ReactorOrb';
import { focusChatInput } from '@/components/hud/useGlobalShortcuts';
import { ToolCallChip } from '@/components/chat/ToolCallChip';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/cn';
import { playSfx } from '@/lib/sfx';
import { useVoiceSession, type VoiceStatus } from '@/hooks/useVoiceSession';
import { useTypewriter } from './useTypewriter';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Modo de voz em tela cheia: núcleo grande, legendas ao vivo, ferramentas em execução
 * e controles (microfone, encerrar, texto). Sempre montado; aparece quando useUi.voiceMode.
 */
export function VoiceModeOverlay() {
  const voiceMode = useUi((s) => s.voiceMode);

  // Ciclo de vida da sessão acompanha o modo de voz.
  useEffect(() => {
    if (!voiceMode) return;
    playSfx('listen');
    useVoiceSession.getState().start();
    return () => {
      useVoiceSession.getState().stop();
      playSfx('stop');
    };
  }, [voiceMode]);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{voiceMode && <VoiceStage key="voice-stage" />}</AnimatePresence>
    </MotionConfig>
  );
}

// ─── Palco ────────────────────────────────────────────────────────────────

function readViewport() {
  if (typeof window === 'undefined') return '1280x800';
  const vv = window.visualViewport;
  const w = Math.round((vv?.width ?? window.innerWidth) / 8) * 8;
  const h = Math.round((vv?.height ?? window.innerHeight) / 8) * 8;
  return `${w}x${h}`;
}

function subscribeViewport(cb: () => void) {
  window.addEventListener('resize', cb);
  window.visualViewport?.addEventListener('resize', cb);
  return () => {
    window.removeEventListener('resize', cb);
    window.visualViewport?.removeEventListener('resize', cb);
  };
}

/** Diâmetro do núcleo conforme a tela (celular baixo → menor; desktop grande → até 420px). */
function useOrbSize(): number {
  const vp = useSyncExternalStore(subscribeViewport, readViewport, () => '1280x800');
  const [w, h] = vp.split('x').map(Number);
  return Math.round(Math.max(150, Math.min(w * 0.64, (h - 400) * 0.95, 420)));
}

function closeVoice() {
  useUi.getState().set({ voiceMode: false });
}

function switchToText() {
  closeVoice();
  requestAnimationFrame(() => focusChatInput());
}

function VoiceStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const orbSize = useOrbSize();
  const status = useVoiceSession((s) => s.status);
  const muted = useVoiceSession((s) => s.muted);

  // Foco no diálogo ao abrir; devolve ao elemento anterior ao fechar.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = containerRef.current;
    node?.focus({ preventScroll: true });
    return () => {
      // Não rouba o foco se ele já foi levado a outro lugar (ex.: "continuar por texto").
      const active = document.activeElement;
      if (!active || active === document.body || node?.contains(active)) previous?.focus({ preventScroll: true });
    };
  }, []);

  // Atalhos: Esc encerra, M silencia o microfone, Espaço interrompe a fala.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      // Um diálogo aberto por cima (aprovação, configurações) tem prioridade.
      const otherDialog = Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => el !== containerRef.current);
      if (otherDialog) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeVoice();
      } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        useVoiceSession.getState().toggleMute();
      } else if (e.key === ' ' && (target === containerRef.current || target === document.body)) {
        e.preventDefault();
        useVoiceSession.getState().interrupt();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const speaking = status === 'speaking';

  return (
    <motion.div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Modo de voz do Lärk"
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className="fixed inset-0 z-[45] flex flex-col overflow-hidden bg-void/85 outline-none backdrop-blur-xl"
    >
      <Atmosphere />

      <header className="relative z-10 flex items-center gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-8 sm:pt-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 bg-red shadow-glow-sm lark-blink" />
          <span className="font-display text-[11px] font-semibold tracking-[0.34em] text-ink sm:text-xs">CANAL DE VOZ</span>
          <span className="hidden font-mono text-[10px] tracking-[0.26em] text-dim sm:inline">VOX-01</span>
        </div>
        <EngineBadge />
        <button
          type="button"
          onClick={closeVoice}
          aria-label="Encerrar modo de voz (Esc)"
          title="Encerrar (Esc)"
          className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center border border-line-neutral text-muted transition-colors hover:border-line-strong hover:text-ink"
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center gap-4 overflow-y-auto overflow-x-hidden px-4 py-2 [justify-content:safe_center] sm:gap-5">
        <NoticeBar />

        <motion.div
          initial={{ opacity: 0, scale: 0.86 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.94 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="relative"
        >
          <button
            type="button"
            onClick={() => speaking && useVoiceSession.getState().interrupt()}
            aria-label={speaking ? 'Interromper o Lärk' : 'Núcleo do Lärk'}
            aria-disabled={!speaking}
            tabIndex={speaking ? 0 : -1}
            className={cn('block outline-offset-8', speaking ? 'cursor-pointer' : 'cursor-default')}
          >
            <ReactorOrb size={orbSize} variant="full" label="none" intro interactive={false} />
          </button>
        </motion.div>

        <StatusLine status={status} muted={muted} />
        <Captions />
        <ToolsRow />
      </main>

      <footer className="relative z-10 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2 sm:pb-8">
        <div className="flex items-center justify-center gap-6 sm:gap-10">
          <ControlButton
            label={muted ? 'Ativar o microfone (M)' : 'Silenciar o microfone (M)'}
            caption={muted ? 'Mudo' : 'Microfone'}
            active={muted}
            onClick={() => useVoiceSession.getState().toggleMute()}
          >
            {muted ? <MicOff size={20} aria-hidden /> : <Mic size={20} aria-hidden />}
          </ControlButton>

          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={closeVoice}
              aria-label="Encerrar modo de voz"
              className="relative flex h-16 w-16 items-center justify-center border border-red-bright/70 bg-red/90 text-white shadow-glow transition-all duration-150 hover:bg-red hover:shadow-glow-lg active:scale-95"
            >
              <PhoneOff size={22} aria-hidden />
            </button>
            <span className="font-hud text-[10px] font-semibold uppercase tracking-[0.26em] text-muted">Encerrar</span>
          </div>

          <ControlButton label="Continuar por texto" caption="Texto" onClick={switchToText}>
            <Keyboard size={20} aria-hidden />
          </ControlButton>
        </div>
        <p className="mt-4 hidden text-center font-mono text-[9.5px] tracking-[0.24em] text-muted sm:block">
          <kbd className="kbd">ESC</kbd> ENCERRAR · <kbd className="kbd">M</kbd> MICROFONE · <kbd className="kbd">ESPAÇO</kbd> INTERROMPER
        </p>
      </footer>
    </motion.div>
  );
}

// ─── Peças ────────────────────────────────────────────────────────────────

function Atmosphere() {
  const corner = 'pointer-events-none absolute h-8 w-8 border-red/45 sm:h-12 sm:w-12';
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hud-grid opacity-50 [mask-image:radial-gradient(ellipse_at_50%_45%,black_5%,transparent_68%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_42%,rgb(255_30_60/0.17),transparent_58%)]"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 scanlines opacity-70" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-red/50 to-transparent lark-sweep" />
      <span aria-hidden className={cn(corner, 'left-3 top-3 border-l border-t sm:left-5 sm:top-5')} />
      <span aria-hidden className={cn(corner, 'right-3 top-3 border-r border-t sm:right-5 sm:top-5')} />
      <span aria-hidden className={cn(corner, 'bottom-3 left-3 border-b border-l sm:bottom-5 sm:left-5')} />
      <span aria-hidden className={cn(corner, 'bottom-3 right-3 border-b border-r sm:bottom-5 sm:right-5')} />
    </>
  );
}

function EngineBadge() {
  const engine = useVoiceSession((s) => s.engine);
  const model = useVoiceSession((s) => s.model);
  const status = useVoiceSession((s) => s.status);

  let text = 'CONECTANDO';
  let cls = 'border-line-neutral text-muted';
  if (engine === 'live') {
    const short = (model ?? 'gemini').replace(/^models\//, '');
    text = `LIVE • ${short}`;
    cls = 'border-red/50 bg-red/10 text-red-bright';
  } else if (engine === 'classic') {
    text = 'CLÁSSICO';
    cls = 'border-warn/45 bg-warn/10 text-warn';
  } else if (status === 'error') {
    text = 'INDISPONÍVEL';
    cls = 'border-red/40 text-red-soft';
  }

  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-[46vw] items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] sm:max-w-sm',
        cls,
      )}
      title={engine === 'live' && model ? `Gemini Live — ${model}` : undefined}
    >
      {engine === 'live' && <span aria-hidden className="h-1.5 w-1.5 shrink-0 bg-red-bright lark-ping" />}
      <span className="truncate">{text}</span>
    </span>
  );
}

function NoticeBar() {
  const notice = useVoiceSession((s) => s.notice);
  return (
    <div className="absolute inset-x-0 top-1 z-20 flex justify-center px-4">
      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice.text}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className={cn(
              'flex w-full max-w-xl items-start gap-2.5 border px-3 py-2 backdrop-blur-md',
              notice.tone === 'error'
                ? 'border-red/45 bg-red/[0.1] text-ink'
                : notice.tone === 'warn'
                  ? 'border-warn/40 bg-warn/[0.08] text-ink'
                  : 'border-line-strong bg-abyss/80 text-ink',
            )}
          >
            {notice.tone === 'info' ? (
              <Info size={15} className="mt-0.5 shrink-0 text-red-bright" aria-hidden />
            ) : (
              <TriangleAlert size={15} className={cn('mt-0.5 shrink-0', notice.tone === 'error' ? 'text-red-bright' : 'text-warn')} aria-hidden />
            )}
            <p className="min-w-0 flex-1 text-[12.5px] leading-snug">{notice.text}</p>
            <button
              type="button"
              onClick={() => useVoiceSession.getState().dismissNotice()}
              aria-label="Dispensar aviso"
              className="flex h-6 w-6 shrink-0 items-center justify-center text-muted transition-colors hover:text-ink"
            >
              <X size={13} aria-hidden />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const STATUS_COPY: Record<VoiceStatus, { label: string; hint: string }> = {
  idle: { label: 'EM ESPERA', hint: 'Pronto quando você estiver.' },
  connecting: { label: 'ESTABELECENDO CANAL', hint: 'Conectando à voz ao vivo do Gemini…' },
  listening: { label: 'OUVINDO', hint: 'Fale naturalmente — eu acompanho.' },
  thinking: { label: 'PROCESSANDO', hint: 'Organizando o pensamento…' },
  speaking: { label: 'FALANDO', hint: 'Toque no núcleo ou pressione Espaço para interromper.' },
  error: { label: 'CANAL INDISPONÍVEL', hint: 'Você pode continuar por texto enquanto isso.' },
};

function StatusLine({ status, muted }: { status: VoiceStatus; muted: boolean }) {
  const copy = muted && (status === 'listening' || status === 'thinking')
    ? { label: 'MICROFONE SILENCIADO', hint: 'Toque no microfone (ou M) para voltar a falar.' }
    : STATUS_COPY[status];
  const live = status === 'listening' && !muted;
  return (
    <div className="flex flex-col items-center gap-1.5 text-center" role="status" aria-live="polite">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5',
            status === 'error' ? 'bg-red-soft' : muted ? 'bg-warn' : 'bg-red-bright shadow-glow-sm',
            live || status === 'thinking' || status === 'connecting' ? 'lark-blink' : '',
          )}
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copy.label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className={cn(
              'font-hud text-xs font-semibold uppercase tracking-[0.42em] sm:text-[13px]',
              muted ? 'text-warn' : status === 'error' ? 'text-red-soft' : 'text-red-bright text-glow-soft',
            )}
          >
            {copy.label}
          </motion.span>
        </AnimatePresence>
      </div>
      <p className="text-[12px] text-muted">{copy.hint}</p>
    </div>
  );
}

/** Mostra o fim de textos longos, cortando no início de uma palavra. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const space = cut.indexOf(' ');
  return `…${space > 0 && space < 24 ? cut.slice(space + 1) : cut}`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function Captions() {
  const userCaption = useVoiceSession((s) => s.userCaption);
  const userFinal = useVoiceSession((s) => s.userFinal);
  const assistantCaption = useVoiceSession((s) => s.assistantCaption);
  const assistantFinal = useVoiceSession((s) => s.assistantFinal);
  const reduced = useReducedMotion() ?? false;

  const target = stripMarkdown(assistantCaption);
  const shown = useTypewriter(target, !reduced);
  const typing = shown.length < target.length || !assistantFinal;

  return (
    <div className="flex w-full max-w-3xl flex-col items-center gap-2.5 text-center">
      <div className="flex min-h-[2.75rem] w-full items-end justify-center sm:min-h-[3rem]">
        <AnimatePresence mode="wait" initial={false}>
          {userCaption && (
            <motion.p
              key="user"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="line-clamp-2 max-w-2xl text-sm leading-snug text-muted sm:text-base"
            >
              <span className="mr-2 align-middle font-mono text-[9.5px] tracking-[0.3em] text-muted">VOCÊ ›</span>
              {userCaption}
              {!userFinal && <span aria-hidden className="ml-0.5 text-red lark-caret">▍</span>}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <div className="relative flex h-[6.5rem] w-full items-end justify-center overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_38%)] sm:h-[8.25rem]">
        <p
          aria-hidden
          className="max-w-3xl text-balance text-lg font-light leading-snug text-ink sm:text-2xl sm:leading-snug"
        >
          {tail(shown, 300)}
          {shown && typing && <span className="ml-0.5 inline-block h-[1em] w-[0.45em] translate-y-[0.12em] bg-red lark-caret" />}
        </p>
      </div>
      {/* Leitores de tela recebem a resposta inteira uma única vez, ao final. */}
      <p className="sr-only" aria-live="polite">
        {assistantFinal && target ? `Lärk: ${target}` : ''}
      </p>
    </div>
  );
}

function ToolsRow() {
  const tools = useVoiceSession((s) => s.tools);
  return (
    <div className="flex min-h-8 w-full max-w-2xl flex-wrap items-center justify-center gap-2">
      <AnimatePresence initial={false}>
        {tools.slice(-4).map((call) => (
          <motion.div
            key={call.id}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.2 }}
            className="max-w-[min(100%,20rem)]"
          >
            <ToolCallChip call={call} compact className="bg-abyss/70 backdrop-blur-sm" />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function ControlButton({
  label,
  caption,
  active,
  onClick,
  children,
}: {
  label: string;
  caption: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        aria-pressed={active}
        className={cn(
          'relative flex h-14 w-14 items-center justify-center border bg-black/40 transition-all duration-150 active:scale-95',
          active
            ? 'border-warn/70 bg-warn/10 text-warn'
            : 'border-line-strong text-ink hover:border-red hover:text-red-bright hover:shadow-glow-sm',
        )}
      >
        <span aria-hidden className="pointer-events-none absolute -left-px -top-px h-2 w-2 border-l-2 border-t-2 border-red" />
        <span aria-hidden className="pointer-events-none absolute -bottom-px -right-px h-2 w-2 border-b-2 border-r-2 border-red" />
        {children}
      </button>
      <span className="font-hud text-[10px] font-semibold uppercase tracking-[0.26em] text-muted">{caption}</span>
    </div>
  );
}
