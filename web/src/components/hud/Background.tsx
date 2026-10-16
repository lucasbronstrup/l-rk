import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './hooks';

/**
 * Qualidade adaptativa: mede a taxa de quadros alguns segundos após abrir (depois da
 * abertura) e, se a máquina não sustentar ~40 fps, desliga poeira e varredura do fundo.
 * O orbe — a peça que importa — continua intacto.
 */
function useLowPowerMode(): boolean {
  const [lowPower, setLowPower] = useState(false);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let start = 0;
    let last = 0;
    const SAMPLE_MS = 3000;
    const tick = (now: number) => {
      // Um intervalo longo indica aba em segundo plano (rAF congelado): recomeça a amostra.
      if (!start || now - last > 500) {
        start = now;
        frames = 0;
      }
      last = now;
      frames++;
      if (now - start < SAMPLE_MS) {
        raf = requestAnimationFrame(tick);
        return;
      }
      if ((frames * 1000) / (now - start) < 40) setLowPower(true);
    };
    const delay = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, 4500);
    return () => {
      window.clearTimeout(delay);
      cancelAnimationFrame(raf);
    };
  }, []);
  return lowPower;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
  tw: number;
  ph: number;
}

/**
 * Poeira vermelha flutuando devagar. Canvas leve (DPR ≤ 1.5, ~30 fps, pausa fora da aba)
 * e desligado por completo quando o sistema pede movimento reduzido.
 */
function DustCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let w = 0;
    let h = 0;
    let particles: Particle[] = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    const spawn = (anywhere: boolean): Particle => ({
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 10,
      vx: (Math.random() - 0.5) * 6,
      vy: -(4 + Math.random() * 12),
      r: 0.5 + Math.random() * 1.3,
      a: 0.15 + Math.random() * 0.5,
      tw: 0.4 + Math.random() * 1.6,
      ph: Math.random() * Math.PI * 2,
    });

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Densidade proporcional à área, com teto para telas 2560px.
      const count = Math.min(90, Math.round((w * h) / 26000));
      particles = Array.from({ length: count }, () => spawn(true));
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let t = 0;
    const FRAME = 1 / 30;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt;
      if (acc < FRAME) return;
      const step = acc;
      acc = 0;
      t += step;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]!;
        p.x += p.vx * step;
        p.y += p.vy * step;
        if (p.y < -10 || p.x < -10 || p.x > w + 10) particles[i] = spawn(false);
        const alpha = p.a * (0.55 + 0.45 * Math.sin(t * p.tw + p.ph));
        ctx.fillStyle = `rgba(255, 46, 74, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        if (p.r > 1.4) {
          ctx.fillStyle = `rgba(255, 30, 60, ${(alpha * 0.18).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="absolute inset-0 h-full w-full opacity-70" />;
}

/**
 * Fundo vivo da HUD: núcleo avermelhado atrás do orbe, grade técnica, varredura lenta,
 * linhas de scan, ruído de filme e vinheta. Puramente decorativo (aria-hidden, sem eventos).
 */
export function Background() {
  const reduced = usePrefersReducedMotion();
  const lowPower = useLowPowerMode();
  const animated = !reduced && !lowPower;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-void">
      {/* Brilho do núcleo — posicionado atrás do orbe em cada layout */}
      <div
        className="absolute inset-0 [--core-y:14%] md:[--core-y:24%] xl:[--core-y:26%]"
        style={{
          background:
            'radial-gradient(ellipse 60% 48% at 50% var(--core-y), rgb(176 16 42 / 0.26) 0%, rgb(92 7 21 / 0.14) 38%, transparent 72%),' +
            'radial-gradient(ellipse 120% 70% at 50% 120%, rgb(92 7 21 / 0.22) 0%, transparent 60%)',
        }}
      />

      {/* Grade técnica, mais visível ao centro */}
      <div
        className="hud-grid absolute inset-0 opacity-80"
        style={{
          maskImage: 'radial-gradient(ellipse 75% 70% at 50% 40%, #000 15%, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(ellipse 75% 70% at 50% 40%, #000 15%, transparent 78%)',
        }}
      />

      {/* Marcas de mira nos cantos da tela (desktop) */}
      <div className="absolute inset-6 hidden xl:block">
        <span className="absolute left-0 top-0 h-6 w-6 border-l border-t border-line-strong" />
        <span className="absolute right-0 top-0 h-6 w-6 border-r border-t border-line-strong" />
        <span className="absolute bottom-0 left-0 h-6 w-6 border-b border-l border-line-strong" />
        <span className="absolute bottom-0 right-0 h-6 w-6 border-b border-r border-line-strong" />
      </div>

      {animated && <DustCanvas />}

      {/* Faixa de varredura descendo devagar */}
      {animated && (
        <div
          className="lark-sweep absolute inset-x-0 top-0 h-[22vh]"
          style={{
            background: 'linear-gradient(to bottom, transparent, rgb(255 30 60 / 0.035) 70%, rgb(255 30 60 / 0.08) 98%, transparent)',
          }}
        />
      )}

      <div className="scanlines absolute inset-0 opacity-60" />
      <div className="noise absolute inset-0 opacity-[0.045] mix-blend-overlay" />

      {/* Vinheta */}
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(ellipse 90% 85% at 50% 45%, transparent 55%, rgb(0 0 0 / 0.72) 100%)' }}
      />
    </div>
  );
}
