import { useEffect, useRef, useState } from 'react';

/**
 * Revela `target` progressivamente (efeito de digitação), acelerando quando há atraso
 * acumulado — a legenda nunca fica muito atrás da voz. Se o texto mudar de rumo
 * (não estende o que já foi mostrado), recomeça do prefixo em comum.
 */
export function useTypewriter(target: string, enabled: boolean, baseCps = 46): string {
  const [shown, setShown] = useState(enabled ? '' : target);
  const shownRef = useRef(shown);

  useEffect(() => {
    if (!enabled) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let current = shownRef.current;
    if (!target.startsWith(current)) {
      let i = 0;
      const max = Math.min(current.length, target.length);
      while (i < max && current[i] === target[i]) i++;
      current = target.slice(0, i);
      shownRef.current = current;
      setShown(current);
    }
    if (current.length >= target.length) return;

    let pos = current.length;
    let last = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const backlog = target.length - pos;
      pos = Math.min(target.length, pos + (baseCps + backlog * 2.4) * dt);
      const next = target.slice(0, Math.floor(pos));
      if (next !== shownRef.current) {
        shownRef.current = next;
        setShown(next);
      }
      if (pos < target.length) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [target, enabled, baseCps]);

  return shown;
}
