import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from './hooks';

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#/<>*+=';
const SCRAMBLABLE = /[A-Za-z0-9À-ÿ]/;

interface ScrambleTextProps {
  text: string;
  className?: string;
  /** Duração da decodificação em ms. */
  duration?: number;
}

/**
 * Texto que "decodifica" caractere a caractere quando muda (efeito de terminal HUD).
 * Leitores de tela recebem só o texto final; com movimento reduzido, troca direto.
 */
export function ScrambleText({ text, className, duration = 420 }: ScrambleTextProps) {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    if (reduced || text.length === 0) {
      setDisplay(text);
      return;
    }
    let raf = 0;
    let lastFrame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      // ~30 quadros por segundo bastam para o efeito e economizam renderizações.
      if (now - lastFrame >= 32 || p >= 1) {
        lastFrame = now;
        const revealed = Math.floor(p * text.length);
        let out = '';
        for (let i = 0; i < text.length; i++) {
          const ch = text[i]!;
          out += i < revealed || !SCRAMBLABLE.test(ch) ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
        setDisplay(out);
      }
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration, reduced]);

  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>{display}</span>
    </span>
  );
}
