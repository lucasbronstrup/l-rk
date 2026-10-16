import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowDown, ArrowUp, Battery, BatteryCharging, Cpu, Network, Power, Thermometer, Timer } from 'lucide-react';
import type { SystemVitals } from '@shared/types';
import { HudButton, HudPanel } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatDuration, formatPct, formatRate } from '@/lib/format';
import { useData } from '@/store/data';
import { EASE_OUT_EXPO, PanelEmpty, PanelError, SectionLabel, TechCode } from './parts';

const POLL_MS = 4000;

// ─── Cor por carga ──────────────────────────────────────────────────────

/** Interpola do vermelho profundo (#5c0715) ao vermelho brilhante (#ff4b5f) conforme t ∈ [0,1]. */
function heat(t: number): string {
  const stops = [
    [0, [140, 12, 32]],
    [0.5, [255, 30, 60]],
    [1, [255, 95, 112]],
  ] as const;
  const x = Math.max(0, Math.min(1, t));
  const i = x <= 0.5 ? 0 : 1;
  const [a, ca] = stops[i];
  const [b, cb] = stops[i + 1];
  const k = (x - a) / (b - a);
  const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

const loadTone = (pct: number) => (pct >= 85 ? 'critical' : pct >= 60 ? 'high' : 'normal');

// ─── Medidor circular segmentado ───────────────────────────────────────

const SEGMENTS = 36;
const SWEEP = 270;
const START = 135; // graus (0 = direita, sentido horário no SVG)

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
}

function arcPath(r: number, from: number, to: number) {
  const [x1, y1] = polar(50, 50, r, from);
  const [x2, y2] = polar(50, 50, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const Gauge = memo(function Gauge({ label, pct, detail, code }: { label: string; pct: number | null; detail?: string; code: string }) {
  const value = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const lit = Math.round((value / 100) * SEGMENTS);
  const tone = loadTone(value);
  const segments = useMemo(
    () =>
      Array.from({ length: SEGMENTS }, (_, i) => {
        const deg = START + (SWEEP / (SEGMENTS - 1)) * i;
        const [x1, y1] = polar(50, 50, 33, deg);
        const [x2, y2] = polar(50, 50, 41, deg);
        return { x1, y1, x2, y2, color: heat(i / (SEGMENTS - 1)) };
      }),
    [],
  );
  const progressLen = (Math.PI * 2 * 45 * SWEEP) / 360;

  return (
    <figure className="flex min-w-0 flex-col items-center" aria-label={`${label}: ${pct === null ? 'sem leitura' : formatPct(value)}`}>
      <div className={cn('relative aspect-square w-full max-w-[124px]', tone === 'critical' && 'drop-shadow-[0_0_10px_rgb(255_30_60/0.45)]')}>
        <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden>
          {/* Trilho externo fino e progresso preciso */}
          <path d={arcPath(45, START, START + SWEEP)} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth="1" />
          <path
            d={arcPath(45, START, START + SWEEP)}
            fill="none"
            stroke={heat(value / 100)}
            strokeWidth="1.4"
            strokeDasharray={`${progressLen} ${progressLen}`}
            strokeDashoffset={progressLen * (1 - value / 100)}
            style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.16,1,0.3,1), stroke 0.8s' }}
          />
          {/* Segmentos */}
          {segments.map((s, i) => (
            <line
              key={i}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              strokeWidth="2.6"
              stroke={i < lit ? s.color : 'rgb(255 255 255 / 0.07)'}
              style={{ transition: `stroke 0.35s ease ${i * 6}ms` }}
            />
          ))}
          {/* Marcas internas */}
          <circle cx="50" cy="50" r="28" fill="none" stroke="rgb(255 30 60 / 0.14)" strokeWidth="0.6" strokeDasharray="1 3" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pt-1">
          <span
            className={cn(
              'tabular font-display text-[1.1rem] font-semibold leading-none sm:text-[1.3rem]',
              tone === 'critical' ? 'text-red-bright text-glow' : tone === 'high' ? 'text-red-soft' : 'text-ink',
            )}
          >
            {pct === null ? '—' : Math.round(value)}
            {pct !== null && <span className="ml-0.5 text-[0.55em] text-muted">%</span>}
          </span>
          <span className="mt-1 font-hud text-[10px] font-bold uppercase tracking-[0.26em] text-muted">{label}</span>
        </div>
        <span aria-hidden className="absolute bottom-[6%] left-1/2 -translate-x-1/2 font-mono text-[8px] tracking-[0.2em] text-dim">
          {code}
        </span>
      </div>
      {detail && <figcaption className="mt-1 max-w-full truncate text-center font-mono text-[10px] text-dim">{detail}</figcaption>}
    </figure>
  );
});

// ─── Peças ──────────────────────────────────────────────────────────────

function Readout({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border border-line-neutral bg-black/20 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-dim">
        <span className="text-red/70">{icon}</span>
        <span className="font-hud text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">{label}</span>
      </div>
      <div className="tabular mt-1 truncate font-hud text-[14px] font-semibold text-ink">{children}</div>
    </div>
  );
}

function BatteryBar({ percent, charging }: { percent: number; charging: boolean }) {
  const lit = Math.round(percent / 10);
  return (
    <span className="flex items-center gap-2">
      <span className="flex gap-[2px]" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            className={cn('h-2.5 w-1', i < lit ? (percent <= 15 ? 'bg-red-bright motion-safe:animate-pulse-red' : 'bg-red') : 'bg-white/10')}
          />
        ))}
      </span>
      <span>
        {Math.round(percent)}%{charging && <span className="ml-1 text-[11px] font-medium text-red-soft">carregando</span>}
      </span>
    </span>
  );
}

function ProcessTable({ processes }: { processes: SystemVitals['topProcesses'] }) {
  if (!processes.length) return null;
  const max = Math.max(1, ...processes.map((p) => p.cpuPct));
  return (
    <section aria-label="Processos com maior consumo">
      <SectionLabel className="px-0">Processos</SectionLabel>
      <table className="w-full table-fixed text-left">
        <thead className="sr-only">
          <tr>
            <th>Processo</th>
            <th>CPU</th>
            <th>Memória</th>
          </tr>
        </thead>
        <tbody>
          {processes.slice(0, 6).map((p) => (
            <tr key={`${p.pid}-${p.name}`} className="border-b border-line-neutral/60 last:border-0">
              <td className="w-[55%] py-1.5 pr-2">
                <span className="block truncate font-mono text-[11px] text-ink" title={`${p.name} (PID ${p.pid})`}>
                  {p.name}
                </span>
              </td>
              <td className="py-1.5 pr-2">
                <span className="flex items-center gap-1.5">
                  <span className="relative h-1 flex-1 bg-white/[0.06]" aria-hidden>
                    <span className="absolute inset-y-0 left-0 bg-red transition-[width] duration-700" style={{ width: `${(p.cpuPct / max) * 100}%` }} />
                  </span>
                  <span className="tabular w-10 text-right font-mono text-[10.5px] text-muted">{formatPct(p.cpuPct, 1)}</span>
                </span>
              </td>
              <td className="tabular w-12 py-1.5 text-right font-mono text-[10.5px] text-dim">{formatPct(p.memPct, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ─── Coleta (somente quando visível) ────────────────────────────────────

function useVitalsPolling(enabled: boolean) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const active = enabled && inView && pageVisible;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    let timer: number | undefined;
    const tick = async () => {
      controller = new AbortController();
      await useData.getState().loadVitals(controller.signal);
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [active]);

  return { rootRef, active };
}

// ─── Painel ──────────────────────────────────────────────────────────────

export function SystemPanel() {
  const settings = useData((s) => s.settings);
  const health = useData((s) => s.health);
  const vitals = useData((s) => s.vitals);
  const error = useData((s) => s.vitalsError);
  const vitalsAt = useData((s) => s.vitalsAt);
  const enabled = settings?.computer.enabled !== false;
  const { rootRef, active } = useVitalsPolling(enabled);
  const [enabling, setEnabling] = useState(false);

  const stale = vitalsAt !== null && Date.now() - vitalsAt > POLL_MS * 3;
  const statusCode = !enabled ? 'SYS//OFF' : error && !vitals ? 'SYS//FALHA' : stale ? 'SYS//INSTÁVEL' : active ? 'SYS//ONLINE' : 'SYS//PAUSA';
  const mainDisk = vitals?.disks.slice().sort((a, b) => b.totalBytes - a.totalBytes)[0] ?? null;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-col">
      <HudPanel
        title="Sistema"
        code="SYS-04"
        icon={<Cpu size={14} />}
        className="flex-1"
        bodyClassName="flex flex-col"
        actions={
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                'h-1.5 w-1.5',
                enabled && active && !stale && !error ? 'bg-red-bright shadow-[0_0_6px_rgb(255_30_60/0.9)] motion-safe:animate-pulse-red' : 'bg-dim',
              )}
            />
            <TechCode>{statusCode}</TechCode>
          </span>
        }
      >
        {!enabled ? (
          <PanelEmpty
            icon={<Power size={20} />}
            title="Acesso desligado"
            quote="Sem acesso, sou apenas uma voz. Com ele, torno-me a consciência desta máquina."
            action={
              <HudButton
                size="sm"
                variant="outline"
                disabled={enabling}
                icon={<Power size={13} />}
                onClick={async () => {
                  setEnabling(true);
                  await useData.getState().saveSettings({ computer: { enabled: true } }, { toast: 'Acesso ao computador ativado' });
                  setEnabling(false);
                }}
              >
                Ativar acesso
              </HudButton>
            }
          />
        ) : !vitals ? (
          error ? (
            <PanelError message={error} onRetry={() => void useData.getState().loadVitals()} />
          ) : (
            <div className="grid grid-cols-3 gap-3 p-4" aria-busy="true" aria-label="Lendo sensores">
              {[0, 1, 2].map((i) => (
                <div key={i} className="mx-auto aspect-square w-full max-w-[110px] rounded-full border border-line motion-safe:animate-pulse" />
              ))}
            </div>
          )
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
            {/* Identidade da máquina */}
            <div className="flex items-baseline justify-between gap-3 pb-2 pt-3">
              <div className="min-w-0">
                <p className="truncate font-hud text-[15px] font-semibold uppercase tracking-[0.12em] text-ink" title={vitals.hostname}>
                  {vitals.hostname || health?.hostname || 'Computador'}
                </p>
                <p className="truncate font-mono text-[10px] text-dim" title={vitals.osName}>
                  {vitals.osName || vitals.platform}
                </p>
              </div>
              <TechCode className="shrink-0">{vitals.platform}</TechCode>
            </div>

            {/* Medidores */}
            <motion.div
              className="grid grid-cols-3 gap-2 py-2 sm:gap-3"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
            >
              <Gauge
                label="CPU"
                code="C-01"
                pct={vitals.cpu.loadPct}
                detail={`${vitals.cpu.cores} núcleos${vitals.cpu.tempC !== null ? ` · ${Math.round(vitals.cpu.tempC)}°C` : ''}`}
              />
              <Gauge label="RAM" code="M-02" pct={vitals.memory.usedPct} detail={`${formatBytes(vitals.memory.usedBytes)} / ${formatBytes(vitals.memory.totalBytes)}`} />
              <Gauge
                label="Disco"
                code="D-03"
                pct={mainDisk?.usedPct ?? null}
                detail={mainDisk ? `${formatBytes(mainDisk.totalBytes - mainDisk.usedBytes)} livres` : 'sem disco'}
              />
            </motion.div>

            {/* Leituras */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Readout icon={<Timer size={11} />} label="Ativo há">
                {formatDuration(vitals.uptimeSec)}
              </Readout>
              {vitals.battery.hasBattery && vitals.battery.percent !== null ? (
                <Readout icon={vitals.battery.charging ? <BatteryCharging size={11} /> : <Battery size={11} />} label="Bateria">
                  <BatteryBar percent={vitals.battery.percent} charging={Boolean(vitals.battery.charging)} />
                </Readout>
              ) : vitals.cpu.tempC !== null ? (
                <Readout icon={<Thermometer size={11} />} label="Temperatura">
                  {Math.round(vitals.cpu.tempC)}°C
                </Readout>
              ) : (
                <Readout icon={<Power size={11} />} label="Energia">
                  Tomada
                </Readout>
              )}
              {vitals.network && (
                <div className="col-span-2 min-w-0 border border-line-neutral bg-black/20 px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <Network size={11} className="text-red/70" aria-hidden />
                    <span className="font-hud text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Rede</span>
                    <span className="ml-auto truncate font-mono text-[10px] text-dim">
                      {vitals.network.iface}
                      {vitals.network.ip4 ? ` · ${vitals.network.ip4}` : ''}
                    </span>
                  </div>
                  <div className="tabular mt-1 flex items-center gap-4 font-hud text-[14px] font-semibold text-ink">
                    <span className="inline-flex items-center gap-1" aria-label={`Download ${formatRate(vitals.network.rxSec)}`}>
                      <ArrowDown size={12} className="text-red-bright" aria-hidden />
                      {formatRate(vitals.network.rxSec)}
                    </span>
                    <span className="inline-flex items-center gap-1" aria-label={`Upload ${formatRate(vitals.network.txSec)}`}>
                      <ArrowUp size={12} className="text-red-soft" aria-hidden />
                      {formatRate(vitals.network.txSec)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <ProcessTable processes={vitals.topProcesses} />

            <p className="mt-2 truncate font-mono text-[9px] uppercase tracking-[0.2em] text-dim" title={vitals.cpu.model}>
              {vitals.cpu.model}
            </p>
          </div>
        )}
      </HudPanel>
    </div>
  );
}
