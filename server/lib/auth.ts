/**
 * Autenticação opcional por senha (LARK_PASSWORD) e proteções de origem da API.
 *
 * - Sem senha: a API fica aberta, mas o servidor só escuta em 127.0.0.1 por padrão
 *   (`assertSafeStartup` recusa expor o Lärk na rede sem senha).
 * - Com senha: POST /api/auth/login compara em tempo constante e emite um cookie httpOnly
 *   (SameSite=Lax, 30 dias) assinado com HMAC-SHA256. O segredo do HMAC é derivado da senha + um
 *   sal aleatório persistido no banco — trocar a senha invalida todas as sessões.
 * - `originGuard` bloqueia requisições de outros sites (CSRF) e DNS rebinding: o Lärk controla o
 *   computador, então nenhuma página aleatória aberta no navegador pode falar com ele.
 * - `installVoiceAuth()` aplica a mesma sessão ao WebSocket da voz (/api/voice).
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import os from 'node:os';
import type { IncomingMessage } from 'node:http';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from '../config.js';
import { readSettingValue, writeSettingValue } from '../memory/settings.js';
import { setVoiceAuthChecker } from '../voice/live.js';

export const SESSION_COOKIE = 'lark_session';
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const TOKEN_VERSION = 'v1';
const SALT_KEY = 'auth.salt';

// ─── Senha e segredo ─────────────────────────────────────────────────────

/** true quando há senha configurada (LARK_PASSWORD). Lido a cada chamada (os testes alteram o config). */
export function isAuthRequired(): boolean {
  return Boolean(config.password);
}

let secretCache: { password: string; salt: string; secret: Buffer } | null = null;

/** Sal aleatório persistido no banco (criado na primeira vez). */
function getSalt(): string {
  const stored = readSettingValue<string>(SALT_KEY);
  if (typeof stored === 'string' && /^[0-9a-f]{32,}$/.test(stored)) return stored;
  const salt = randomBytes(32).toString('hex');
  writeSettingValue(SALT_KEY, salt);
  return salt;
}

/** Segredo do HMAC: scrypt(senha, sal). Em cache enquanto senha e sal não mudarem. */
function getSecret(): Buffer {
  const password = config.password;
  const salt = getSalt();
  if (secretCache && secretCache.password === password && secretCache.salt === salt) return secretCache.secret;
  const secret = scryptSync(password, `lark-session:${salt}`, 32);
  secretCache = { password, salt, secret };
  return secret;
}

/** Compara a senha informada com a configurada em tempo constante. */
export function checkPassword(candidate: unknown): boolean {
  if (!isAuthRequired() || typeof candidate !== 'string') return false;
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(config.password, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// ─── Token de sessão ─────────────────────────────────────────────────────

function sign(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/** Cria um token de sessão `v1.<expira-em-ms>.<nonce>.<assinatura>`. */
export function createSessionToken(now: Date = new Date()): string {
  const expires = now.getTime() + SESSION_MAX_AGE_SEC * 1000;
  const payload = `${TOKEN_VERSION}.${expires}.${randomBytes(12).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

/** Valida assinatura e validade de um token de sessão. */
export function verifySessionToken(token: string | null | undefined, now: Date = new Date()): boolean {
  if (!token || typeof token !== 'string' || token.length > 512 || !isAuthRequired()) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false;
  const [version, expiresRaw, nonce, signature] = parts;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return false;
  const expected = Buffer.from(sign(`${version}.${expiresRaw}.${nonce}`));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Extrai um cookie de um cabeçalho `Cookie` cru (usado no upgrade do WebSocket). */
export function readCookieFromHeader(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header ?? '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** true se a requisição pode usar a API (sem senha configurada, ou com sessão válida). */
export function isRequestAuthenticated(c: Context): boolean {
  if (!isAuthRequired()) return true;
  return verifySessionToken(getCookie(c, SESSION_COOKIE));
}

function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Emite o cookie de sessão (após login bem-sucedido). */
export function issueSessionCookie(c: Context): void {
  setCookie(c, SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
    secure: isSecureRequest(c),
  });
}

/** Remove o cookie de sessão (logout). */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isSecureRequest(c) });
}

// ─── Limite de tentativas de login ───────────────────────────────────────

const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map<string, number[]>();

function clientKey(c: Context): string {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}

/** Segundos até poder tentar de novo (0 = liberado). */
export function loginRetryAfter(c: Context, now = Date.now()): number {
  const recent = (loginFailures.get(clientKey(c)) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length < LOGIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((recent[0] + LOGIN_WINDOW_MS - now) / 1000));
}

export function recordLoginFailure(c: Context, now = Date.now()): void {
  const key = clientKey(c);
  const recent = (loginFailures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  recent.push(now);
  loginFailures.set(key, recent.slice(-LOGIN_MAX_FAILURES));
  if (loginFailures.size > 1000) loginFailures.delete(loginFailures.keys().next().value as string);
}

export function clearLoginFailures(c?: Context): void {
  if (c) loginFailures.delete(clientKey(c));
  else loginFailures.clear();
}

// ─── Hosts e origens ─────────────────────────────────────────────────────

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(?:\.\d{1,3}){3})$/i;
const PRIVATE =
  /^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|[a-z0-9-]+\.local|[a-z0-9-]+\.ts\.net|\[?f[cd][0-9a-f]{2}:[0-9a-f:]*\]?)$/i;

/** true para 127.0.0.1, ::1 e localhost (o servidor só é acessível pelo próprio computador). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim().replace(/^\[(.*)\]$/, '$1'));
}

function allowedExtraHosts(): string[] {
  return (process.env.LARK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Host local (loopback, rede privada, nome da máquina) ou liberado em LARK_ALLOWED_HOSTS. */
export function isTrustedHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return true;
  return LOOPBACK.test(h) || PRIVATE.test(h) || h === os.hostname().toLowerCase() || allowedExtraHosts().includes(h);
}

function hostnameOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[(.*)\]$/, '[$1]');
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Proteção contra outros sites (CSRF) e DNS rebinding:
 * - Host: sem senha, só hosts locais (ou LARK_ALLOWED_HOSTS) — um domínio estranho apontando para
 *   127.0.0.1 não consegue ler a API.
 * - Origin: requisições que mudam dados vindas de outro site são recusadas.
 */
export const originGuard: MiddlewareHandler = async (c, next) => {
  const requestHostname = hostnameOfUrl(c.req.url) ?? '';
  if (!isAuthRequired() && !isTrustedHostname(requestHostname)) {
    return c.json({ error: 'Host não autorizado. Acesse o Lärk pelo endereço local ou configure LARK_ALLOWED_HOSTS.' }, 403);
  }
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = c.req.header('origin');
    if (origin && origin !== 'null') {
      const originHost = hostOf(origin);
      const originHostname = hostnameOfUrl(origin) ?? '';
      const sameHost = originHost !== null && originHost === hostOf(c.req.url);
      // Só a própria página (mesmo host), o loopback (ex.: Vite em localhost:5173) ou hosts liberados.
      const trusted = sameHost || isLoopbackHost(originHostname) || allowedExtraHosts().includes(originHostname);
      if (!trusted) return c.json({ error: 'Origem não autorizada: outro site tentou controlar o Lärk.' }, 403);
    } else if (origin === 'null') {
      return c.json({ error: 'Origem não autorizada.' }, 403);
    }
  }
  await next();
};

/** Caminhos liberados sem sessão (relativos a /api). */
function isPublicPath(path: string): boolean {
  const p = path.replace(/^\/api(?=\/|$)/, '') || '/';
  return p === '/health' || p === '/auth' || p.startsWith('/auth/');
}

/** Exige sessão válida em /api/* (exceto /auth/* e /health) quando há senha configurada. */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (!isAuthRequired() || isPublicPath(c.req.path) || isRequestAuthenticated(c)) {
    await next();
    return;
  }
  return c.json({ error: 'Acesso restrito: entre com a senha do Lärk para continuar.', code: 'unauthorized' }, 401);
};

/** Aplica a sessão por cookie também ao WebSocket da voz. */
export function installVoiceAuth(): void {
  setVoiceAuthChecker((req: IncomingMessage) => {
    if (!isAuthRequired()) return true;
    return verifySessionToken(readCookieFromHeader(req.headers.cookie, SESSION_COOKIE));
  });
}

// ─── Segurança na inicialização ──────────────────────────────────────────

/**
 * Mensagem de erro (PT-BR) quando a configuração é insegura, ou null quando está tudo certo:
 * expor o Lärk fora do loopback sem senha daria controle do computador a qualquer um na rede.
 */
export function startupSecurityProblem(host: string = config.host, password: string = config.password): string | null {
  if (password || isLoopbackHost(host)) return null;
  return [
    `O Lärk foi configurado para escutar em "${host}", fora deste computador, mas não há senha definida.`,
    'Ele tem acesso total aos seus arquivos e ao sistema — expor isso na rede sem senha é perigoso.',
    'Defina LARK_PASSWORD no arquivo .env (ex.: LARK_PASSWORD=uma-senha-forte) ou volte HOST para 127.0.0.1.',
  ].join('\n');
}

/** Lança erro se a configuração de rede for insegura (chamado pelo server/index.ts antes de escutar). */
export function assertSafeStartup(): void {
  const problem = startupSecurityProblem();
  if (problem) throw new Error(problem);
}
