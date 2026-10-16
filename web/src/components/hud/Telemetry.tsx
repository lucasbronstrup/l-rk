import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUi } from '@/store/ui';
import { useData } from '@/store/data';
import { cn } from '@/lib/cn';
import { usePrefersReducedMotion } from './hooks';

const numberFmt = new Intl.NumberFormat('pt-BR');

function Row({ label, children, align }: { label: string; children: ReactNode; align: 'left' | 'right' }) {
  return (
    <div className={cn('relative flex min-w-0 flex-col gap-0.5', align === 'right' ? 'items-end text-right' : 'items-start text-left')}>
      {/* Marcador no trilho vertical voltado para o orbe */}
      <span
        aria-hidden
        className={cn('absolute top-1 h-1.5 w-1.5 rotate-45 bg-red/70', align === 'right' ? '-right-[19px]' : '-left-[19px]')}
      />
      <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-dim">{label}</span>
      <span className="tabular w-full truncate font-hud text-[14px] font-semibold tracking-[0.06em] text-ink">{children}</span>
    </div>
  );
}

/** Medidor de sinal em segmentos, lido do nível de voz via rAF (sem re-render). */
function SignalMeter() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const bars = Array.from(ref.current?.children ?? []) as HTMLElement[];
    if (bars.length === 0) return;
    let level = 0;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const raw = Math.max(0, Math.min(1, useUi.getState().voiceLevel || 0));
      level += (raw - level) * (1 - Math.exp(-dt / (raw > level ? 0.04 : 0.18)));
      const lit = level * bars.length;
      for (let i = 0; i < bars.length; i++) {
        const on = Math.max(0, Math.min(1, lit - i));
        bars[i]!.style.opacity = (0.16 + on * 0.84).toFixed(2);
        if (!reduced) bars[i]!.style.transform = `scaleY(${(0.45 + on * 0.55).toFixed(2)})`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  return (
    <div ref={ref} className="flex h-3.5 items-end gap-[3px]" aria-hidden>
      {Array.from({ length: 14 }, (_, i) => (
        <span
          key={i}
          className={cn('block h-full w-[3px] origin-bottom will-change-transform', i >= 11 ? 'bg-red-bright' : 'bg-red')}
          style={{ opacity: 0.16, transform: 'scaleY(0.45)' }}
        />
      ))}
    </div>
  );
}

/** Cronômetro da sessão atual (desde que a página abriu). */
function SessionTimer() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.floor((now - start) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return <>{`${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`}</>;
}

interface TelemetryProps {
  side: 'left' | 'right';
  className?: string;
}

/**
 * Colunas de telemetria que ladeiam o orbe no desktop: modelo, voz, canal e sinal à esquerda;
 * memória, conversas, promessas e sessão à direita.
 */
export function Telemetry({ side, className }: TelemetryProps) {
  const health = useData((s) => s.health);
  const settings = useData((s) => s.settings);
  const stats = useData((s) => s.memoryStats);
  const commitments = useData((s) => s.commitments);
  const voiceMode = useUi((s) => s.voiceMode);

  const align = side === 'left' ? 'right' : 'left';
  const rail = side === 'left' ? 'border-r pr-4' : 'border-l pl-4';

  if (side === 'left') {
    const model = health?.mock ? 'demonstração' : (health?.activeModels?.chat?.replace(/^models\//, '') ?? 'automático');
    return (
      <div className={cn('w-36 shrink-0 flex-col gap-3.5 border-line py-1', rail, className)} aria-label="Telemetria do núcleo">
        <Row label="Modelo" align={align}>
          <span className="font-mono text-[11.5px] font-normal">{model}</span>
        </Row>
        <Row label="Voz" align={align}>
          {settings?.voiceName ? settings.voiceName.toUpperCase() : '—'}
        </Row>
        <Row label="Canal" align={align}>
          <span className={voiceMode ? 'text-red-bright text-glow-soft' : undefined}>{voiceMode ? 'VOZ' : 'TEXTO'}</span>
        </Row>
        <Row label="Sinal" align={align}>
          <span className="flex justify-end pt-1">
            <SignalMeter />
          </span>
        </Row>
      </div>
    );
  }

  const pending = Array.isArray(commitments) ? commitments.filter((c) => c.status === 'pending').length : null;
  return (
    <div className={cn('w-36 shrink-0 flex-col gap-3.5 border-line py-1', rail, className)} aria-label="Telemetria da memória">
      <Row label="Memória" align={align}>
        {stats ? (
          <>
            {numberFmt.format(stats.memories)} <span className="text-[11px] font-medium text-muted">registros</span>
          </>
        ) : (
          '—'
        )}
      </Row>
      <Row label="Conversas" align={align}>
        {stats ? numberFmt.format(stats.conversations) : '—'}
      </Row>
      <Row label="Promessas" align={align}>
        {pending === null ? (
          '—'
        ) : (
          <>
            <span className={pending > 0 ? 'text-red-bright' : undefined}>{pending}</span>{' '}
            <span className="text-[11px] font-medium text-muted">em aberto</span>
          </>
        )}
      </Row>
      <Row label="Sessão" align={align}>
        <SessionTimer />
      </Row>
    </div>
  );
}
