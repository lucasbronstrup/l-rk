/**
 * Utilidades do backend local da edição web: ids, datas, erros HTTP e respostas.
 */

export const nowIso = (): string => new Date().toISOString();

export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* contexto não seguro: cai no gerador abaixo */
  }
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rnd()}${rnd()}-${rnd()}-4${rnd().slice(1)}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}

/** Erro com status HTTP e mensagem pronta para o usuário (PT-BR). */
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

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = 'Não encontrado — talvez já tenha sido apagado.') => new HttpError(404, message);

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return jsonResponse({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
  console.error('[Lärk web] Erro interno:', e);
  const message = e instanceof Error && e.message ? e.message : 'O núcleo do Lärk encontrou um erro interno.';
  return jsonResponse({ error: message, code: 'internal' }, 500);
}

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbort(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Lê um campo string opcional de um corpo JSON. */
export function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}
