import { EventEmitter } from 'node:events';
import type { LarkEvent } from '../../shared/types.js';

/**
 * Barramento de eventos interno. Tudo que a interface precisa saber em tempo real
 * passa por aqui e é retransmitido pelo SSE GET /api/events.
 */
class LarkBus extends EventEmitter {
  publish(event: LarkEvent): void {
    this.emit('event', event);
  }
  subscribe(listener: (event: LarkEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const bus = new LarkBus();
bus.setMaxListeners(100);
