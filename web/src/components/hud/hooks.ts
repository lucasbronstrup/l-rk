import { useSyncExternalStore } from 'react';

/** Faixas de layout da interface: celular (<768px), tablet (768–1279px) e desktop (≥1280px). */
export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const DESKTOP_QUERY = '(min-width: 1280px)';
const TABLET_QUERY = '(min-width: 768px)';

const hasMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function readBreakpoint(): Breakpoint {
  if (!hasMatchMedia()) return 'desktop';
  if (window.matchMedia(DESKTOP_QUERY).matches) return 'desktop';
  if (window.matchMedia(TABLET_QUERY).matches) return 'tablet';
  return 'mobile';
}

function subscribeBreakpoint(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const queries = [window.matchMedia(DESKTOP_QUERY), window.matchMedia(TABLET_QUERY)];
  queries.forEach((q) => q.addEventListener('change', onChange));
  return () => queries.forEach((q) => q.removeEventListener('change', onChange));
}

/** Breakpoint atual, reativo a redimensionamentos (renderiza só quando a faixa muda). */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribeBreakpoint, readBreakpoint, () => 'desktop');
}

/** Lê o breakpoint fora do React (atalhos de teclado, handlers). */
export function getBreakpoint(): Breakpoint {
  return readBreakpoint();
}

// ─── Altura útil da janela ──────────────────────────────────────────────

/** Arredonda em passos de 8px para não re-renderizar a cada pixel durante o redimensionamento. */
const readViewportHeight = () => {
  if (typeof window === 'undefined') return 900;
  const h = window.visualViewport?.height ?? window.innerHeight;
  return Math.round(h / 8) * 8;
};

function subscribeViewport(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('resize', onChange);
  window.visualViewport?.addEventListener('resize', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.visualViewport?.removeEventListener('resize', onChange);
  };
}

/** Altura visível da janela (considera teclado virtual via visualViewport). */
export function useViewportHeight(): number {
  return useSyncExternalStore(subscribeViewport, readViewportHeight, () => 900);
}

// ─── Movimento reduzido ─────────────────────────────────────────────────

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduced(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const q = window.matchMedia(REDUCED_QUERY);
  q.addEventListener('change', onChange);
  return () => q.removeEventListener('change', onChange);
}

const readReduced = () => (hasMatchMedia() ? window.matchMedia(REDUCED_QUERY).matches : false);

/** true quando o sistema pede menos movimento (usado pelos loops de canvas). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, readReduced, () => false);
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
