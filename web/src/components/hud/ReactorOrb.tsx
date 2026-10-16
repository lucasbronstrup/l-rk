import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { useUi, type OrbState } from '@/store/ui';
import { playSfx } from '@/lib/sfx';
import { cn } from '@/lib/cn';
import { ScrambleText } from './ScrambleText';
import { clamp, usePrefersReducedMotion } from './hooks';

// ─── Configuração visual por estado ─────────────────────────────────────

export const ORB_STATE_LABELS: Record<OrbState, string> = {
  idle: 'AGUARDANDO',
  listening: 'OUVINDO',
  thinking: 'PROCESSANDO',
  speaking: 'FALANDO',
  alert: 'ALERTA',
  offline: 'OFFLINE',
};

/** Cor principal (SVG via currentColor). */
const CSS_COLOR: Record<OrbState, string> = {
  idle: '#ff1e3c',
  listening: '#ff4b5f',
  thinking: '#ff1e3c',
  speaking: '#ff4b5f',
  alert: '#ff2a2a',
  offline: '#5f5557',
};

type Rgb = [number, number, number];
const CANVAS_COLOR: Record<OrbState, Rgb> = {
  idle: [255, 30, 60],
  listening: [255, 88, 106],
  thinking: [255, 30, 60],
  speaking: [255, 75, 95],
  alert: [255, 42, 42],
  offline: [95, 85, 87],
};
const AMBER: Rgb = [255, 176, 32];

/** Alvos dinâmicos por estado: velocidades angulares (graus/s) e intensidades 0..1. */
interface Dynamics {
  outer: number;
  dashed: number;
  arcs: number;
  data: number;
  coils: number;
  glow: number;
  core: number;
  wave: number;
  scan: number;
  alert: number;
}
type DynKey = keyof Dynamics;
const DYN_KEYS: DynKey[] = ['outer', 'dashed', 'arcs', 'data', 'coils', 'glow', 'core', 'wave', 'scan', 'alert'];

const DYNAMICS: Record<OrbState, Dynamics> = {
  idle: { outer: 4, dashed: -7, arcs: 10, data: -2.5, coils: 1.5, glow: 0.5, core: 0.86, wave: 0.6, scan: 0, alert: 0 },
  listening: { outer: 26, dashed: -15, arcs: 30, data: -5, coils: 3, glow: 0.85, core: 1, wave: 1, scan: 0, alert: 0 },
  thinking: { outer: 12, dashed: -50, arcs: 150, data: -16, coils: 12, glow: 0.72, core: 0.92, wave: 0.7, scan: 1, alert: 0 },
  speaking: { outer: 8, dashed: -12, arcs: 22, data: -4, coils: 2.5, glow: 0.82, core: 1, wave: 1, scan: 0, alert: 0 },
  alert: { outer: 34, dashed: -34, arcs: 70, data: -10, coils: 6, glow: 1, core: 1, wave: 0.8, scan: 0, alert: 1 },
  offline: { outer: 0, dashed: 0, arcs: 0, data: 0, coils: 0, glow: 0.06, core: 0.28, wave: 0, scan: 0, alert: 0 },
};

// ─── Geometria (viewBox 400×400, centro 200,200) ────────────────────────

const C = 200;
const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
const polar = (r: number, deg: number) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))] as const;
const fmt = (n: number) => n.toFixed(2);

function arcPath(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${fmt(x0)} ${fmt(y0)}A${r} ${r} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)}`;
}

function ticksPath(count: number, every: number, rIn: number, rOut: number, skipEvery?: number): string {
  let d = '';
  for (let i = 0; i < count; i++) {
    if (i % every !== 0) continue;
    if (skipEvery && i % skipEvery === 0) continue;
    const a = (360 / count) * i;
    const [x0, y0] = polar(rIn, a);
    const [x1, y1] = polar(rOut, a);
    d += `M${fmt(x0)} ${fmt(y0)}L${fmt(x1)} ${fmt(y1)}`;
  }
  return d;
}

/** Segmentos do anel de arcos (graus). */
const ARC_SEGMENTS: [number, number, number][] = [
  [-82, -22, 0.95],
  [-14, 6, 0.45],
  [14, 72, 0.9],
  [98, 116, 0.5],
  [126, 198, 0.95],
  [212, 228, 0.45],
  [240, 262, 0.8],
];

/** Bobinas do "reator" ao redor do núcleo: 10 trapézios. */
function coilPolygons(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a0 = i * 36 + 3;
    const a1 = a0 + 30;
    const pts = [polar(78, a0 + 2.5), polar(96, a0), polar(96, a1), polar(78, a1 - 2.5)];
    out.push(pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' '));
  }
  return out;
}

/** Escreve a rotação direto no estilo (camada composta pela GPU, sem re-render). */
function rotate(el: SVGSVGElement | null, deg: number) {
  if (el) el.style.transform = `rotate(${(deg % 360).toFixed(2)}deg)`;
}

const DATA_TEXT =
  'LÄRK // NÚCLEO NEURAL ATIVO · MEMÓRIA PERMANENTE · SYS//ONLINE · 0x4C52-4B · CONSCIÊNCIA DO SISTEMA HOSPEDEIRO · VOZ-01 · ';

// ─── Componente ─────────────────────────────────────────────────────────

export interface ReactorOrbProps {
  /** Diâmetro em pixels. */
  size?: number;
  /** 'full' (todas as camadas) ou 'compact' (menos detalhes, traços mais grossos). */
  variant?: 'full' | 'compact';
  /** Rótulo de estado: abaixo, ao lado ou oculto. */
  label?: 'below' | 'side' | 'none';
  /** Animação de montagem das camadas (abertura). */
  intro?: boolean;
  /** Clicar alterna o modo de voz (padrão: sim). */
  interactive?: boolean;
  /** Força um estado visual (ignora useUi.orbState). */
  stateOverride?: OrbState;
  className?: string;
}

/**
 * O núcleo do Lärk: anéis em SVG girando com velocidades por estado e uma forma de onda
 * circular em canvas que reage ao nível de voz. Todo o movimento roda num único
 * requestAnimationFrame que escreve transform/opacity direto no DOM — nenhuma
 * re-renderização do React acontece a 60 Hz.
 */
export function ReactorOrb({
  size = 260,
  variant = 'full',
  label = 'below',
  intro = false,
  interactive = true,
  stateOverride,
  className,
}: ReactorOrbProps) {
  const orbState = useUi((s) => s.orbState);
  const connection = useUi((s) => s.connection);
  const voiceMode = useUi((s) => s.voiceMode);
  const reduced = usePrefersReducedMotion();

  // Sem servidor, o núcleo apaga — independentemente do que a voz/chat informem.
  const state: OrbState = stateOverride ?? (connection === 'offline' ? 'offline' : orbState);
  // O loop de animação lê o estado por ref (sem reiniciar a cada mudança).
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const compact = variant === 'compact';
  const showData = !compact && size >= 200;
  // Traços finos ficam invisíveis em orbes pequenos: engrossa proporcionalmente.
  const sw = clamp(260 / size, 1, 2.8);

  const rawId = useId();
  const pathId = `orb-data-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const rootRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<SVGSVGElement>(null);
  const dashedRef = useRef<SVGSVGElement>(null);
  const arcsRef = useRef<SVGSVGElement>(null);
  const dataRef = useRef<SVGSVGElement>(null);
  const coilsRef = useRef<SVGSVGElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Ângulos acumulados sobrevivem a mudanças de tamanho (sem "saltos"). */
  const anglesRef = useRef({ outer: 0, dashed: 0, arcs: 0, data: 0, coils: 0 });

  const geometry = useMemo(() => {
    const tickCount = compact ? 60 : 120;
    return {
      major: ticksPath(tickCount, compact ? 5 : 10, 173, 192),
      mid: ticksPath(tickCount, compact ? 1 : 5, 180, 191, compact ? 5 : 10),
      minor: compact ? '' : ticksPath(tickCount, 1, 184, 190, 5),
      arcs: ARC_SEGMENTS.map(([a0, a1, o]) => ({ d: arcPath(148, a0, a1), o })),
      coils: coilPolygons(),
      innerTicks: compact ? '' : ticksPath(48, 1, 64, 69),
      partial: arcPath(158, 200, 318),
      partial2: arcPath(158, 20, 70),
    };
  }, [compact]);

  // ── Loop de animação ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cur: Dynamics = { ...DYNAMICS[stateRef.current] };
    const color: Rgb = [...CANVAS_COLOR[stateRef.current]];
    const angles = anglesRef.current;
    let level = 0;
    let coreScale = 1;
    let t = 0;
    let last = performance.now();
    let raf = 0;
    let visible = true;

    const observer =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            visible = entries.some((e) => e.isIntersecting);
          })
        : null;
    if (rootRef.current) observer?.observe(rootRef.current);

    const S = size;
    const half = S / 2;
    const r0 = S * 0.272;
    const POINTS = compact ? 72 : 128;
    const BARS = compact ? 36 : 72;

    const rgba = (a: number, c: Rgb = color) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;

    const drawWave = (amp: number, voice: number, wave: number) => {
      ctx.clearRect(0, 0, S, S);
      if (wave < 0.01 && cur.scan < 0.01) {
        // Offline: anel único e apagado.
        ctx.beginPath();
        ctx.arc(half, half, r0, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(0.25);
        ctx.lineWidth = 1;
        ctx.stroke();
        return;
      }
      ctx.globalCompositeOperation = 'lighter';

      const shape = (theta: number, phase: number) =>
        Math.sin(theta * 3 + t * 1.3 + phase) * 0.45 +
        Math.sin(theta * 5 - t * 2.1 + phase * 1.7) * 0.3 +
        Math.sin(theta * 11 + t * 4.3 - phase) * 0.25 * (0.3 + voice) +
        Math.sin(theta * 19 - t * 7.1) * 0.22 * voice;

      const trace = (radius: number, a: number, phase: number) => {
        ctx.beginPath();
        for (let i = 0; i <= POINTS; i++) {
          const theta = (i / POINTS) * Math.PI * 2;
          const r = radius + a * shape(theta, phase);
          const x = half + r * Math.cos(theta);
          const y = half + r * Math.sin(theta);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      };

      // Halo largo (brilho barato, sem shadowBlur).
      trace(r0, amp, 0);
      ctx.strokeStyle = rgba(0.07 + voice * 0.16);
      ctx.lineWidth = compact ? 4 : 7;
      ctx.stroke();
      // Traço principal.
      ctx.strokeStyle = rgba(0.55 + wave * 0.35);
      ctx.lineWidth = compact ? 1.2 : 1.6;
      ctx.stroke();
      // Eco defasado.
      trace(r0 * 1.055, amp * 0.8, 1.9);
      ctx.strokeStyle = rgba(0.18 + voice * 0.25);
      ctx.lineWidth = 1;
      ctx.stroke();

      // Barras radiais (espectro) quando há voz.
      if (voice > 0.02 && !compact) {
        ctx.beginPath();
        const base = r0 * 1.13;
        for (let i = 0; i < BARS; i++) {
          const theta = (i / BARS) * Math.PI * 2;
          const n = Math.abs(Math.sin(theta * 7 + t * 5.2) * Math.cos(theta * 3 - t * 2.3));
          const len = S * 0.055 * voice * (0.25 + 0.75 * n);
          ctx.moveTo(half + base * Math.cos(theta), half + base * Math.sin(theta));
          ctx.lineTo(half + (base + len) * Math.cos(theta), half + (base + len) * Math.sin(theta));
        }
        ctx.strokeStyle = rgba(0.25 + voice * 0.5);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // Varredura giratória ao processar (cometa com rastro).
      if (cur.scan > 0.02) {
        const head = t * 4.2;
        const segs = 14;
        for (let i = 0; i < segs; i++) {
          const a1 = head - i * 0.09;
          ctx.beginPath();
          ctx.arc(half, half, r0 * 1.02, a1 - 0.09, a1);
          ctx.strokeStyle = rgba(cur.scan * (1 - i / segs) * 0.9);
          ctx.lineWidth = compact ? 2 : 2.6;
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (!visible) return;

      const st = stateRef.current;
      const target = DYNAMICS[st];
      const k = 1 - Math.exp(-dt / 0.55);
      for (const key of DYN_KEYS) cur[key] += (target[key] - cur[key]) * k;

      // Nível de voz com ataque rápido e liberação suave.
      const raw = clamp(useUi.getState().voiceLevel || 0, 0, 1);
      const lk = 1 - Math.exp(-dt / (raw > level ? 0.035 : 0.14));
      level += (raw - level) * lk;
      const voice = st === 'listening' || st === 'speaking' ? level : level * 0.25;

      if (!reduced) {
        t += dt;
        angles.outer += (cur.outer + voice * 40) * dt;
        angles.dashed += cur.dashed * dt;
        angles.arcs += cur.arcs * dt;
        angles.data += cur.data * dt;
        angles.coils += cur.coils * dt;
      }

      // Escala do núcleo por estado.
      let targetScale: number;
      if (reduced) targetScale = 1 + voice * 0.1;
      else if (st === 'idle') targetScale = 1 + Math.sin(t * 1.55) * 0.035;
      else if (st === 'listening') targetScale = 1.04 + voice * 0.14 + Math.sin(t * 2.4) * 0.012;
      else if (st === 'thinking') targetScale = 1 + 0.07 * Math.pow(Math.max(0, Math.sin(t * 5.2)), 6) + Math.sin(t * 1.6) * 0.012;
      else if (st === 'speaking') targetScale = 1 + voice * 0.24;
      else if (st === 'alert') targetScale = 1 + 0.045 * Math.sin(t * 9);
      else targetScale = 0.94;
      coreScale += (targetScale - coreScale) * (1 - Math.exp(-dt / 0.07));

      const blink = reduced ? 1 : 0.5 + 0.5 * Math.sin(t * 10);
      const alertMix = cur.alert;

      // Cor do canvas (âmbar ↔ vermelho no alerta).
      const base = CANVAS_COLOR[st];
      const tc: Rgb =
        st === 'alert'
          ? [base[0] + (AMBER[0] - base[0]) * blink, base[1] + (AMBER[1] - base[1]) * blink, base[2] + (AMBER[2] - base[2]) * blink]
          : base;
      const ck = 1 - Math.exp(-dt / 0.12);
      color[0] += (tc[0] - color[0]) * ck;
      color[1] += (tc[1] - color[1]) * ck;
      color[2] += (tc[2] - color[2]) * ck;

      rotate(outerRef.current, angles.outer);
      rotate(dashedRef.current, angles.dashed);
      rotate(arcsRef.current, angles.arcs);
      rotate(dataRef.current, angles.data);
      // O anel de microtextos recua quando a voz ocupa o espaço com a forma de onda.
      if (dataRef.current) dataRef.current.style.opacity = (1 - voice * 0.75).toFixed(3);
      rotate(coilsRef.current, angles.coils);

      if (coreRef.current) {
        coreRef.current.style.transform = `scale(${coreScale.toFixed(4)})`;
        coreRef.current.style.opacity = (cur.core * (1 - alertMix * 0.35 * (1 - blink))).toFixed(3);
      }
      if (glowRef.current) {
        const thinkPulse = st === 'thinking' && !reduced ? Math.pow(Math.max(0, Math.sin(t * 5.2)), 4) * 0.25 : 0;
        glowRef.current.style.opacity = clamp(cur.glow * (0.6 + voice * 0.5) + thinkPulse, 0, 1).toFixed(3);
        glowRef.current.style.transform = `scale(${(1 + voice * 0.14).toFixed(4)})`;
      }
      if (alertRef.current) {
        alertRef.current.style.opacity = (alertMix * (0.25 + 0.75 * blink * blink)).toFixed(3);
      }

      const amp = S * (0.009 + 0.075 * voice) * cur.wave;
      drawWave(amp, voice, cur.wave);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [size, compact, reduced]);

  const toggleVoice = useCallback(() => {
    const ui = useUi.getState();
    playSfx('click');
    ui.set({ voiceMode: !ui.voiceMode });
  }, []);

  const layer = (i: number) =>
    intro
      ? {
          initial: { opacity: 0, scale: 0.6 + i * 0.04, rotate: i % 2 ? 70 : -70 },
          animate: { opacity: 1, scale: 1, rotate: 0 },
          transition: { delay: 0.1 + i * 0.12, duration: 0.95, ease: [0.16, 1, 0.3, 1] as const },
        }
      : { initial: false as const };

  const layerClass = 'pointer-events-none absolute inset-0';
  const svgClass = 'absolute inset-0 h-full w-full overflow-visible will-change-transform';
  const stateLabel = ORB_STATE_LABELS[state];
  const labelId = `${pathId}-label`;

  const stage = (
    <div
      ref={rootRef}
      className="relative shrink-0 transition-[color] duration-700"
      style={{ width: size, height: size, color: CSS_COLOR[state] }}
    >
      {/* Halo */}
      <div
        ref={glowRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full will-change-transform"
        style={{
          background:
            'radial-gradient(circle, color-mix(in srgb, currentColor 55%, transparent) 0%, color-mix(in srgb, currentColor 18%, transparent) 34%, transparent 68%)',
          opacity: 0.5,
        }}
      />

      {/* Moldura estática: anel externo com retículos cardinais */}
      <motion.div aria-hidden className={layerClass} {...layer(0)}>
        <svg viewBox="0 0 400 400" className={svgClass} fill="none">
          <circle cx={C} cy={C} r={198} stroke="currentColor" strokeOpacity={0.16} strokeWidth={1 * sw} />
          {[0, 90, 180, 270].map((a) => {
            const [x0, y0] = polar(199, a - 3);
            const [x1, y1] = polar(199, a + 3);
            const [x2, y2] = polar(193, a);
            return <path key={a} d={`M${fmt(x0)} ${fmt(y0)}L${fmt(x1)} ${fmt(y1)}L${fmt(x2)} ${fmt(y2)}Z`} fill="currentColor" fillOpacity={0.85} />;
          })}
          {!compact &&
            [45, 135, 225, 315].map((a) => (
              <path key={a} d={arcPath(198, a - 6, a + 6)} stroke="currentColor" strokeWidth={2.2} strokeOpacity={0.7} />
            ))}
        </svg>
      </motion.div>

      {/* Anel de marcações (gira devagar; acelera ao ouvir) */}
      <motion.div aria-hidden className={layerClass} {...layer(1)}>
        <svg ref={outerRef} viewBox="0 0 400 400" className={svgClass} fill="none" strokeLinecap="butt">
          <path d={geometry.major} stroke="currentColor" strokeWidth={1.7 * sw} strokeOpacity={0.95} />
          <path d={geometry.mid} stroke="currentColor" strokeWidth={1.2 * sw} strokeOpacity={0.6} />
          {geometry.minor && <path d={geometry.minor} stroke="currentColor" strokeWidth={0.9} strokeOpacity={0.32} />}
          <path d="M200 29 L195.5 37.5 L204.5 37.5 Z" fill="currentColor" fillOpacity={0.9} />
        </svg>
      </motion.div>

      {/* Anel tracejado contra-rotativo */}
      <motion.div aria-hidden className={layerClass} {...layer(2)}>
        <svg ref={dashedRef} viewBox="0 0 400 400" className={svgClass} fill="none">
          <circle
            cx={C}
            cy={C}
            r={167}
            stroke="currentColor"
            strokeWidth={2 * Math.min(sw, 1.8)}
            strokeOpacity={0.5}
            strokeDasharray={compact ? '3 7' : '1.5 5.5'}
          />
          {!compact && (
            <>
              <path d={geometry.partial} stroke="currentColor" strokeWidth={1.2} strokeOpacity={0.55} />
              <path d={geometry.partial2} stroke="currentColor" strokeWidth={1.2} strokeOpacity={0.35} />
            </>
          )}
        </svg>
      </motion.div>

      {/* Arcos segmentados (giram rápido ao processar) */}
      <motion.div aria-hidden className={layerClass} {...layer(3)}>
        <svg ref={arcsRef} viewBox="0 0 400 400" className={svgClass} fill="none">
          {geometry.arcs.map((a, i) => (
            <path key={i} d={a.d} stroke="currentColor" strokeWidth={compact ? 12 : 7} strokeOpacity={a.o} />
          ))}
          <circle cx={C} cy={C} r={138} stroke="currentColor" strokeWidth={0.8 * sw} strokeOpacity={0.28} />
        </svg>
      </motion.div>

      {/* Anel de dados com microtextos */}
      {showData && (
        <motion.div aria-hidden className={layerClass} {...layer(4)}>
          <svg ref={dataRef} viewBox="0 0 400 400" className={svgClass}>
            <defs>
              <path id={pathId} d={`M${C} ${C - 124} A124 124 0 1 1 ${C - 0.01} ${C - 124}`} />
            </defs>
            <text
              fill="currentColor"
              fillOpacity={0.5}
              fontFamily="'JetBrains Mono', ui-monospace, monospace"
              fontSize={7.2}
            >
              <textPath href={`#${pathId}`} textLength={Math.round(2 * Math.PI * 124 - 4)} lengthAdjust="spacing">
                {DATA_TEXT}
              </textPath>
            </text>
          </svg>
        </motion.div>
      )}

      {/* Forma de onda circular (canvas) */}
      <motion.div aria-hidden className={layerClass} {...layer(5)}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      </motion.div>

      {/* Bobinas do reator + anel interno */}
      <motion.div aria-hidden className={layerClass} {...layer(6)}>
        <svg ref={coilsRef} viewBox="0 0 400 400" className={svgClass} fill="none">
          <circle cx={C} cy={C} r={101} stroke="currentColor" strokeWidth={0.9 * sw} strokeOpacity={0.35} />
          {geometry.coils.map((pts, i) => (
            <polygon
              key={i}
              points={pts}
              fill="currentColor"
              fillOpacity={i % 2 ? 0.1 : 0.18}
              stroke="currentColor"
              strokeOpacity={0.7}
              strokeWidth={1 * sw}
              strokeLinejoin="miter"
            />
          ))}
          <circle cx={C} cy={C} r={72} stroke="currentColor" strokeWidth={1.2 * sw} strokeOpacity={0.6} />
          {geometry.innerTicks && <path d={geometry.innerTicks} stroke="currentColor" strokeWidth={0.8} strokeOpacity={0.4} />}
        </svg>
      </motion.div>

      {/* Núcleo incandescente */}
      <motion.div aria-hidden className={layerClass} {...layer(7)}>
        <div
          ref={coreRef}
          className="absolute rounded-full will-change-transform"
          style={{
            left: '30%',
            top: '30%',
            width: '40%',
            height: '40%',
            background:
              'radial-gradient(circle, rgb(255 255 255 / 0.96) 0%, color-mix(in srgb, currentColor 45%, white) 13%, currentColor 30%, color-mix(in srgb, currentColor 40%, transparent) 50%, transparent 70%)',
          }}
        />
      </motion.div>

      {/* Sobreposição de alerta (âmbar piscante) */}
      <div
        ref={alertRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          opacity: 0,
          background: 'radial-gradient(circle, rgb(255 176 32 / 0.28) 0%, rgb(255 176 32 / 0.08) 45%, transparent 70%)',
          boxShadow: 'inset 0 0 0 2px rgb(255 176 32 / 0.55)',
        }}
      />
    </div>
  );

  const labelNode =
    label === 'none' ? null : (
      <div
        id={labelId}
        className={cn('flex min-w-0 flex-col gap-1', label === 'below' ? 'items-center text-center' : 'items-start text-left')}
      >
        <span className="font-mono text-[9px] uppercase tracking-[0.32em] text-dim">Núcleo // Estado</span>
        <span
          className={cn(
            'flex items-center gap-2 font-hud font-semibold uppercase',
            compact ? 'text-[12px] tracking-[0.3em]' : 'text-[13px] tracking-[0.42em]',
            state === 'offline' && 'text-dim',
            state === 'alert' && 'lark-blink text-warn',
            state !== 'offline' && state !== 'alert' && 'text-red-bright text-glow-soft',
          )}
        >
          <span aria-hidden className="opacity-50">
            [
          </span>
          <ScrambleText text={stateLabel} className={compact ? 'mr-[-0.3em]' : 'mr-[-0.42em]'} />
          <span aria-hidden className="opacity-50">
            ]
          </span>
        </span>
        {label === 'side' && interactive && (
          <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-muted">
            {voiceMode ? 'Toque para encerrar a voz' : 'Toque para falar'}
          </span>
        )}
      </div>
    );

  const wrapperClass = cn(
    'flex items-center',
    label === 'side' ? 'flex-row gap-4' : 'flex-col gap-3',
    className,
  );

  if (!interactive) {
    return (
      <div className={wrapperClass} role="img" aria-label={`Núcleo do Lärk — ${stateLabel.toLowerCase()}`}>
        {stage}
        {labelNode}
      </div>
    );
  }

  return (
    <div className={wrapperClass}>
      <button
        type="button"
        onClick={toggleVoice}
        aria-pressed={voiceMode}
        aria-label={voiceMode ? 'Encerrar modo de voz' : 'Ativar modo de voz'}
        aria-describedby={label === 'none' ? undefined : labelId}
        title={voiceMode ? 'Encerrar modo de voz' : 'Falar com o Lärk'}
        className="group relative shrink-0 rounded-full outline-none transition-transform duration-300 ease-out hover:scale-[1.025] active:scale-[0.985] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-red"
      >
        {stage}
      </button>
      {labelNode}
    </div>
  );
}
