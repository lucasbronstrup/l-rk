import type { ChatStreamEvent } from '@shared/types';

/** Erro HTTP com mensagem legível (pt-BR) e, quando houver, o código enviado pelo servidor. */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function isAbortError(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
}

function statusMessage(status: number): string {
  if (status === 401) return 'Sua sessão expirou. Entre novamente para continuar.';
  if (status === 403) return 'Acesso negado pelo servidor do Lärk.';
  if (status === 404) return 'O servidor do Lärk não reconheceu esta rota.';
  if (status === 413) return 'A mensagem é grande demais para ser enviada de uma vez.';
  if (status === 429) return 'Muitas requisições em sequência. Aguarde alguns segundos.';
  if (status >= 500) return 'O núcleo do Lärk encontrou um erro interno.';
  return `A requisição falhou (HTTP ${status}).`;
}

/** Extrai a mensagem de erro de uma resposta (JSON {error|message, code} ou texto curto). */
export async function readHttpError(res: Response): Promise<HttpError> {
  let message = '';
  let code: string | undefined;
  try {
    const text = await res.text();
    if (text) {
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const err = j.error;
        if (typeof err === 'string') message = err;
        else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string')
          message = (err as { message: string }).message;
        else if (typeof j.message === 'string') message = j.message;
        if (typeof j.code === 'string') code = j.code;
      } catch {
        const t = text.trim();
        if (t.length < 280 && !t.startsWith('<')) message = t;
      }
    }
  } catch {
    /* corpo ilegível */
  }
  return new HttpError(res.status, message || statusMessage(res.status), code);
}

export interface SSEMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Parser incremental de Server-Sent Events (especificação WHATWG):
 * campos event/data/id, múltiplas linhas `data:`, comentários `:` e quebras \n, \r\n ou \r.
 */
export function createSSEParser(onMessage: (m: SSEMessage) => void): { push: (chunk: string) => void; end: () => void } {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;

  const dispatch = () => {
    if (data.length > 0) onMessage({ event: event || 'message', data: data.join('\n'), id });
    event = '';
    data = [];
  };

  const processLine = (line: string) => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        // "\r" no fim do buffer pode ser metade de um "\r\n": espera o próximo pedaço.
        if (ch === '\r' && i === buffer.length - 1) break;
        processLine(buffer.slice(start, i));
        if (ch === '\r' && buffer[i + 1] === '\n') i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
    end() {
      if (buffer) {
        processLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
      dispatch();
    },
  };
}

function decodeEvent<E extends { type: string }>(m: SSEMessage): E | null {
  if (!m.data) return null;
  try {
    const parsed = JSON.parse(m.data) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== 'string') {
      if (m.event === 'message') return null;
      obj.type = m.event;
    }
    return obj as unknown as E;
  } catch {
    console.warn('[Lärk] Evento SSE ilegível:', m.event, m.data.slice(0, 200));
    return null;
  }
}

/**
 * Faz POST JSON e consome a resposta como SSE, chamando `onEvent` para cada evento.
 * Resolve quando o fluxo termina; rejeita com HttpError em falha HTTP e com AbortError se abortado.
 */
export async function postSSE<E extends { type: string } = ChatStreamEvent>(
  url: string,
  body: unknown,
  onEvent: (e: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok) throw await readHttpError(res);

  const emit = (e: E) => {
    try {
      onEvent(e);
    } catch (err) {
      console.error('[Lärk] Erro ao processar evento do stream:', err);
    }
  };

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    // Servidor respondeu JSON simples (ex.: erro antecipado): trate como evento(s).
    const text = await res.text();
    if (!text.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(res.status, 'Resposta inesperada do servidor do Lärk.');
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string') emit(item as E);
    }
    return;
  }

  if (!res.body) throw new HttpError(res.status, 'Este navegador não suporta respostas em fluxo.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser((m) => {
    const ev = decodeEvent<E>(m);
    if (ev) emit(ev);
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e;
  }
}
