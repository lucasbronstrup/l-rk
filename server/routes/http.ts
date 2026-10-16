/**
 * Utilitários compartilhados pelas rotas REST: leitura de corpo JSON validado com zod,
 * respostas de erro padronizadas ({error}) e tradução de erros de validação dos módulos de dados.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { parseUserDate } from '../memory/time.js';

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;

/** Resposta de erro JSON no formato esperado pela interface: `{ error: "mensagem" }`. */
export function fail(c: Context, status: ApiErrorStatus, error: string, extra: Record<string, unknown> = {}): Response {
  return c.json({ error, ...extra }, status as ContentfulStatusCode);
}

/** Primeira mensagem legível de um erro do zod (com o campo, quando houver). */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Dados inválidos.';
  const field = issue.path.filter((p) => typeof p === 'string' || typeof p === 'number').join('.');
  // Mensagens padrão do zod vêm em inglês ("Invalid input…"): troca por uma genérica em PT-BR.
  const message = /^(invalid|expected|too |unrecognized)/i.test(issue.message)
    ? issue.code === 'unrecognized_keys'
      ? 'campo desconhecido'
      : 'valor inválido'
    : issue.message;
  return field ? `Campo "${field}": ${message}` : message;
}

/** Lê o corpo como JSON (corpo vazio vira `{}`); `undefined` quando não é JSON válido. */
export async function readJsonBody(c: Context): Promise<unknown> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return undefined;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Lê e valida o corpo. Devolve `{ data }` ou `{ response }` com o erro 400 já pronto:
 *   const body = await parseBody(c, schema); if ('response' in body) return body.response;
 */
export async function parseBody<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<{ data: z.infer<T> } | { response: Response }> {
  const raw = await readJsonBody(c);
  if (raw === undefined) return { response: fail(c, 400, 'Corpo inválido: envie um JSON válido.') };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { response: fail(c, 400, describeZodError(parsed.error)) };
  return { data: parsed.data };
}

/** Valida parâmetros de consulta (query string). */
export function parseQuery<T extends z.ZodType>(c: Context, schema: T): { data: z.infer<T> } | { response: Response } {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) return { response: fail(c, 400, describeZodError(parsed.error)) };
  return { data: parsed.data };
}

/** Mensagem de um erro lançado pelos módulos de dados (que já falam PT-BR). */
export function errorText(error: unknown, fallback = 'Não foi possível concluir a operação.'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

/**
 * Executa uma escrita nos módulos de dados; erros de validação deles (Error com mensagem em PT-BR)
 * viram 400. Erros de banco inesperados continuam subindo para o tratador global (500).
 */
export function runValidated<T>(c: Context, fn: () => T): { value: T } | { response: Response } {
  try {
    return { value: fn() };
  } catch (error) {
    if (error instanceof Error && error.name === 'SqliteError') throw error;
    return { response: fail(c, 400, errorText(error)) };
  }
}

/** Inteiro opcional vindo da query string (aceita "", ausente → undefined). */
export const queryInt = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `use um número inteiro entre ${min} e ${max}` });
        return z.NEVER;
      }
      return n;
    });

/** Texto opcional da query string (vazio → undefined). */
export const queryText = (max = 500) =>
  z
    .string()
    .max(max, `texto longo demais (máx. ${max} caracteres)`)
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined));

/** Data em texto (ISO-8601; sem fuso = horário local do usuário). A conversão é feita por `toUtcIso`. */
export const dateText = (label: string) =>
  z.string({ error: `Informe ${label} em ISO-8601.` }).trim().min(1, `Informe ${label}.`).max(64, `${label} inválida.`);

/**
 * Converte uma data enviada pela interface para ISO UTC. Sem fuso explícito, interpreta no fuso
 * do usuário (settings.timezone). Lança InvalidDateError (mensagem PT-BR) quando inválida.
 */
export function toUtcIso(value: string, timeZone: string): string {
  try {
    return parseUserDate(value, { timeZone });
  } catch (error) {
    // Formatos que o Date entende mas o ISO estrito não (ex.: RFC 2822).
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return date.toISOString();
    throw error;
  }
}
