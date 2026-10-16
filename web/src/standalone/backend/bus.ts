import type { LarkEvent } from '@shared/types';

type Listener = (e: LarkEvent) => void;

const listeners = new Set<Listener>();

/** Barramento de eventos do backend local (equivalente ao server/lib/bus.ts). */
export const bus = {
  publish(e: LarkEvent): void {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch (err) {
        console.error('[Lärk web] Falha num ouvinte de eventos:', err);
      }
    }
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
