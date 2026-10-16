/**
 * Server-Sent Events nos dois sentidos:
 *  - leitura do SSE do Gemini (createSSEReader);
 *  - criação de respostas text/event-stream locais (sseResponse) no formato "event: <type>\ndata: <json>\n\n".
 */
import { abortError } from './util';

export interface SSEMessage {
  event: string;
  data: string;
}

/** Itera as mensagens SSE de uma resposta HTTP. */
export async function* createSSEReader(res: Response): AsyncGenerator<SSEMessage> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const flushLine = (line: string): SSEMessage | null => {
    if (line === '') {
      const msg = data.length ? { event: event || 'message', data: data.join('\n') } : null;
      event = '';
      data = [];
      return msg;
    }
    if (line.startsWith(':')) return null;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const msg = flushLine(line);
        if (msg) yield msg;
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const msg = flushLine(buffer);
      if (msg) yield msg;
    }
    const last = flushLine('');
    if (last) yield last;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

const encoder = new TextEncoder();

export function encodeEvent(ev: { type: string }): Uint8Array {
  return encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

export interface SSEWriter {
  send(ev: { type: string }): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Resposta text/event-stream alimentada por `run`. Se o leitor cancelar ou o sinal da requisição
 * abortar, `onAbort` é chamado e o fluxo termina com AbortError (como num fetch real).
 */
export function sseResponse(signal: AbortSignal | undefined, run: (w: SSEWriter) => void | Promise<void>, onAbort?: () => void): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const writer: SSEWriter = {
    send(ev) {
      if (closed) return;
      try {
        controller.enqueue(encodeEvent(ev));
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        /* já encerrado */
      }
    },
    get closed() {
      return closed;
    },
  };
  const abort = () => {
    if (!closed) {
      closed = true;
      try {
        controller.error(abortError());
      } catch {
        /* já encerrado */
      }
    }
    onAbort?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      queueMicrotask(() => {
        Promise.resolve()
          .then(() => run(writer))
          .catch((e: unknown) => {
            console.error('[Lärk web] Falha no fluxo SSE:', e);
            writer.send({ type: 'error', message: 'O núcleo do Lärk encontrou um erro interno.', code: 'internal' } as { type: string });
            writer.close();
          });
      });
    },
    cancel() {
      closed = true;
      signal?.removeEventListener('abort', abort);
      onAbort?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
