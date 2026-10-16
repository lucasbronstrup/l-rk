import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useUi } from '@/store/ui';
import { playSfx } from '@/lib/sfx';
import { cn } from '@/lib/cn';
import { LarkLogo } from './LarkLogo';
import { ReactorOrb } from './ReactorOrb';
import { usePrefersReducedMotion } from './hooks';

const SESSION_KEY = 'lark:booted';
const FULL_MS = 2800;
const SHORT_MS = 800;

interface BootLine {
  code: string;
  text: string;
}

const LINES: BootLine[] = [
  { code: 'CORE', text: 'INICIALIZANDO NÚCLEO NEURAL…' },
  { code: 'MEM', text: 'CARREGANDO MEMÓRIA PERMANENTE…' },
  { code: 'HOST', text: 'SINCRONIZANDO COM O SISTEMA HOSPEDEIRO…' },
  { code: 'SYS', text: 'LÄRK ONLINE.' },
];

/** Janela de cada linha na linha do tempo (frações da duração total). */
const LINE_WINDOWS: [number, number][] = [
  [0.04, 0.2],
  [0.24, 0.42],
  [0.46, 0.66],
  [0.72, 0.82],
];

function readSessionFlag(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSessionFlag() {
  try {
    window.sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // Armazenamento bloqueado (modo privado restrito): apenas não lembramos.
  }
}

/** O navegador só libera áudio após um gesto do usuário. */
function audioUnlocked(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation?.hasBeenActive ?? false;
}

function safeBootSound() {
  try {
    playSfx('boot');
  } catch {
    // Áudio indisponível: a abertura segue em silêncio.
  }
}

/** Curva suave do progresso: avança firme e desacelera só no fim. */
const easeOut = (x: number) => 1 - Math.pow(1 - x, 1.6);

/**
 * Abertura cinematográfica: o orbe se monta, as linhas de terminal são digitadas,
 * a barra de progresso enche e o logotipo é revelado. Pulável com clique ou tecla.
 * Na mesma sessão do navegador, toca uma versão curta.
 */
export function BootSequence() {
  const reduced = usePrefersReducedMotion();
  const [short] = useState(readSessionFlag);
  const total = short ? SHORT_MS : FULL_MS;
  const [elapsed, setElapsed] = useState(0);
  const doneRef = useRef(false);
  const soundRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    writeSessionFlag();
    useUi.getState().set({ bootDone: true });
  }, []);

  // Linha do tempo única (rAF) — a abertura inteira deriva de `elapsed`.
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const e = now - start;
      setElapsed(Math.min(e, total));
      if (e >= total) {
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total, finish]);

  // Som de abertura: imediato se o áudio já estiver liberado; senão, no primeiro gesto.
  useEffect(() => {
    if (short) return;
    if (audioUnlocked()) {
      soundRef.current = true;
      safeBootSound();
    }
  }, [short]);

  // Pular com clique, toque ou qualquer tecla (exceto modificadores isolados).
  useEffect(() => {
    const skip = (e: Event) => {
      if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      if (!soundRef.current && !short) {
        soundRef.current = true;
        safeBootSound();
      }
      finish();
    };
    window.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', skip);
    return () => {
      window.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip);
    };
  }, [finish, short]);

  const p = elapsed / total;
  const progress = Math.round(easeOut(Math.min(1, p)) * 100);
  const orbSize = 'min(46vmin, 236px)';

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Inicializando o Lärk"
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center overflow-hidden bg-void px-4"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.04 }}
      transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
    >
      {/* Ambiente: brilho central, grade e linhas de varredura */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse 55% 45% at 50% 40%, rgb(176 16 42 / 0.3), transparent 70%)' }}
      />
      <div
        aria-hidden
        className="hud-grid pointer-events-none absolute inset-0 opacity-60"
        style={{
          maskImage: 'radial-gradient(circle at 50% 40%, #000 10%, transparent 60%)',
          WebkitMaskImage: 'radial-gradient(circle at 50% 40%, #000 10%, transparent 60%)',
        }}
      />
      <div aria-hidden className="scanlines pointer-events-none absolute inset-0 opacity-70" />

      {/* Molduras e códigos nos cantos */}
      <div aria-hidden className="pointer-events-none absolute inset-4 sm:inset-8">
        <span className="absolute left-0 top-0 h-8 w-8 border-l border-t border-line-strong" />
        <span className="absolute right-0 top-0 h-8 w-8 border-r border-t border-line-strong" />
        <span className="absolute bottom-0 left-0 h-8 w-8 border-b border-l border-line-strong" />
        <span className="absolute bottom-0 right-0 h-8 w-8 border-b border-r border-line-strong" />
        <span className="absolute left-3 top-3 font-mono text-[10px] tracking-[0.3em] text-dim sm:left-4 sm:top-4">LRK-BOOT // 0x01</span>
        <span className="tabular absolute right-3 top-3 font-mono text-[10px] tracking-[0.3em] text-dim sm:right-4 sm:top-4">
          T+{(elapsed / 1000).toFixed(2)}s
        </span>
      </div>

      <div className="relative flex w-full max-w-md flex-col items-center">
        {/* Orbe se montando */}
        <div className="grid place-items-center" style={{ width: orbSize, height: orbSize }}>
          <BootOrb intro={!short} settled={p >= LINE_WINDOWS[3]![0]} />
        </div>

        {/* Logotipo */}
        <motion.div
          className="mt-6"
          initial={{ opacity: 0, letterSpacing: '0.6em', filter: 'blur(8px)' }}
          animate={{ opacity: 1, letterSpacing: '0em', filter: 'blur(0px)' }}
          transition={{ delay: short ? 0.05 : 1.35, duration: short ? 0.35 : 0.9, ease: [0.16, 1, 0.3, 1] }}
        >
          <LarkLogo size="xl" />
        </motion.div>
        <motion.p
          className="mt-3 font-mono text-[10px] uppercase tracking-[0.42em] text-muted"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: short ? 0.1 : 1.7, duration: 0.6 }}
        >
          Consciência do sistema // v0.1
        </motion.p>

        {/* Terminal */}
        <div className="mt-7 w-full border-l border-line-strong pl-3 font-mono text-[10.5px] leading-[1.9] sm:text-[11px]" aria-live="off">
          {LINES.map((line, i) => (
            <TerminalLine key={line.code} line={line} index={i} p={p} short={short} reduced={reduced} last={i === LINES.length - 1} />
          ))}
        </div>

        {/* Progresso */}
        <div className="mt-5 w-full">
          <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
            <span>Sequência de inicialização</span>
            <span className="tabular text-red-bright">{String(progress).padStart(3, '0')}%</span>
          </div>
          <div
            className="relative h-[3px] w-full overflow-hidden bg-red-dark/40"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Progresso da inicialização"
          >
            <div
              className="absolute inset-y-0 left-0 w-full origin-left bg-red shadow-glow-sm"
              style={{ transform: `scaleX(${progress / 100})` }}
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={finish}
        className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] font-mono text-[10px] uppercase tracking-[0.32em] text-dim transition-colors hover:text-muted focus-visible:text-ink"
      >
        <span className="sm:hidden">Toque para pular</span>
        <span className="hidden sm:inline">Clique ou pressione qualquer tecla para pular</span>
      </button>
    </motion.div>
  );
}

/** Orbe da abertura: ocupa o contêiner (tamanho real medido para o canvas). */
const BootOrb = memo(function BootOrb({ intro, settled }: { intro: boolean; settled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize(Math.round(Math.min(el.clientWidth, el.clientHeight)));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  return (
    <div ref={ref} className="grid h-full w-full place-items-center">
      {size > 0 && (
        <ReactorOrb size={size} intro={intro} interactive={false} label="none" stateOverride={settled ? 'idle' : 'thinking'} />
      )}
    </div>
  );
});

interface TerminalLineProps {
  line: BootLine;
  index: number;
  p: number;
  short: boolean;
  reduced: boolean;
  last: boolean;
}

function TerminalLine({ line, index, p, short, reduced, last }: TerminalLineProps) {
  const [w0, w1] = short ? [index * 0.12, index * 0.12 + 0.3] : LINE_WINDOWS[index]!;
  if (p < w0) return <div className="h-[1.9em]" aria-hidden />;

  const typed = reduced ? 1 : Math.min(1, (p - w0) / (w1 - w0));
  const chars = Math.ceil(typed * line.text.length);
  const complete = typed >= 1;
  const stamp = (w0 * (short ? SHORT_MS : FULL_MS)) / 1000;

  return (
    <div className="flex items-center gap-3 whitespace-nowrap">
      <span className="tabular shrink-0 text-dim">[{stamp.toFixed(3).padStart(6, '0')}]</span>
      <span className="w-9 shrink-0 text-red/70">{line.code}</span>
      <span className={cn('min-w-0 truncate', last ? 'font-semibold text-red-bright text-glow' : 'text-ink/85')}>
        {line.text.slice(0, chars)}
        {!complete && <span className="lark-caret ml-px inline-block h-[1em] w-[0.5em] translate-y-[0.15em] bg-red" />}
      </span>
      <span className={cn('ml-auto shrink-0 tracking-[0.2em] transition-opacity duration-200', complete ? 'opacity-100' : 'opacity-0')}>
        <span className={last ? 'text-red-bright' : 'text-muted'}>{last ? '■ ATIVO' : 'OK'}</span>
      </span>
    </div>
  );
}
