/**
 * Stream global de eventos em tempo real (GET /api/events, text/event-stream).
 *
 * - Retransmite tudo que passa pelo `bus` no formato `event: <type>\ndata: <JSON do evento>\n\n`.
 * - Envia `hello` ao conectar e `ping` a cada 20 s (mantém proxies e o vigia do cliente felizes).
 * - Mantém a contagem de assinantes conectados: o agendador só gera o briefing matinal quando
 *   alguém está olhando (ou na próxima conexão, via `onSubscriberConnected`).
 */
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bus } from './bus.js';
import { nowIso } from './ids.js';
import type { LarkEvent } from '../../shared/types.js';

export const SSE_PING_INTERVAL_MS = 20_000;

/** Fila máxima de eventos pendentes por cliente lento antes de desconectá-lo (ele reconecta e ressincroniza). */
const MAX_PENDING_WRITES = 500;

let subscribers = 0;
const connectListeners = new Set<() => void>();
const closers = new Set<() => void>();

/** Quantos clientes estão conectados ao /api/events agora. */
export function subscriberCount(): number {
  return subscribers;
}

/**
 * Registra uma função chamada sempre que um novo cliente se conecta ao stream de eventos.
 * Devolve a função para cancelar o registro.
 */
export function onSubscriberConnected(listener: () => void): () => void {
  connectListeners.add(listener);
  return () => connectListeners.delete(listener);
}

/** Serializa um evento no formato SSE usado pelo Lärk (útil em testes e diagnósticos). */
export function formatSseEvent(event: LarkEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Encerra todos os streams abertos (desligamento do servidor). */
export function closeAllEventStreams(): void {
  for (const close of [...closers]) {
    try {
      close();
    } catch {
      // stream já encerrado
    }
  }
  closers.clear();
}

/** Responde com o stream SSE de `LarkEvent` até o cliente desconectar. */
export function streamEvents(c: Context): Response {
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(
    c,
    async (stream) => {
      let pending = 0;
      let queue: Promise<void> = Promise.resolve();
      let finish: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });

      const send = (event: LarkEvent) => {
        if (stream.aborted || stream.closed) return;
        if (pending >= MAX_PENDING_WRITES) {
          // Cliente que não consome: corta para não acumular memória; o navegador reconecta sozinho.
          finish();
          return;
        }
        pending++;
        const data = JSON.stringify(event);
        queue = queue
          .then(() => stream.writeSSE({ event: event.type, data }))
          .catch(() => finish())
          .finally(() => {
            pending--;
          });
      };

      const unsubscribe = bus.subscribe(send);
      const ping = setInterval(() => send({ type: 'ping', serverTime: nowIso() }), SSE_PING_INTERVAL_MS);
      ping.unref?.();
      closers.add(finish);
      stream.onAbort(() => finish());

      subscribers++;
      send({ type: 'hello', serverTime: nowIso() });
      for (const listener of [...connectListeners]) {
        try {
          listener();
        } catch (error) {
          console.warn('[eventos] falha num ouvinte de conexão:', error instanceof Error ? error.message : error);
        }
      }

      try {
        await done;
      } finally {
        subscribers = Math.max(0, subscribers - 1);
        clearInterval(ping);
        unsubscribe();
        closers.delete(finish);
        await queue.catch(() => undefined);
      }
    },
    async (error) => {
      console.warn('[eventos] stream encerrado com erro:', error.message);
    },
  );
}
