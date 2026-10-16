import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  process.env.LARK_MOCK = '1';
});

import { Hono } from 'hono';
import { config } from '../config.js';
import { apiRoutes } from './index.js';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  clearLoginFailures,
  createSessionToken,
  isLoopbackHost,
  readCookieFromHeader,
  startupSecurityProblem,
  verifySessionToken,
} from '../lib/auth.js';
import type { HealthInfo } from '../../shared/types.js';

const PASSWORD = 'cotovia-que-canta-subindo';
const app = new Hono().route('/api', apiRoutes);

function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.cookie) headers.Cookie = init.cookie;
  return app.request(`/api${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function sessionCookieFrom(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const value = readCookieFromHeader(header.split(';')[0], SESSION_COOKIE);
  return value ? `${SESSION_COOKIE}=${value}` : '';
}

beforeAll(() => {
  config.password = PASSWORD;
});
beforeEach(() => clearLoginFailures());
afterAll(() => {
  config.password = '';
});

describe('autenticação por senha', () => {
  it('protege a API, mas deixa /health e /auth/* públicos', async () => {
    expect((await call('/memories')).status).toBe(401);
    expect((await call('/settings')).status).toBe(401);
    expect((await call('/events')).status).toBe(401);
    const health = await call('/health');
    expect(health.status).toBe(200);
    expect((await health.json() as HealthInfo).authRequired).toBe(true);
    const status = await (await call('/auth/status')).json();
    expect(status).toEqual({ required: true, authenticated: false });
  });

  it('recusa senha errada e aceita a certa com cookie httpOnly/SameSite=Lax de 30 dias', async () => {
    const wrong = await call('/auth/login', { method: 'POST', body: { password: 'errada' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const ok = await call('/auth/login', { method: 'POST', body: { password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ required: true, authenticated: true });
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain(`Max-Age=${SESSION_MAX_AGE_SEC}`);

    const cookie = sessionCookieFrom(ok);
    expect((await call('/memories', { cookie })).status).toBe(200);
    expect(await (await call('/auth/status', { cookie })).json()).toEqual({ required: true, authenticated: true });

    const logout = await call('/auth/logout', { method: 'POST', cookie });
    expect(logout.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
  });

  it('rejeita cookies adulterados ou expirados', async () => {
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
    const tampered = token.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
    expect(verifySessionToken(tampered)).toBe(false);
    expect((await call('/memories', { cookie: `${SESSION_COOKIE}=${tampered}` })).status).toBe(401);

    const old = createSessionToken(new Date(Date.now() - (SESSION_MAX_AGE_SEC + 60) * 1000));
    expect(verifySessionToken(old)).toBe(false);
    expect(verifySessionToken('lixo')).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
  });

  it('trocar a senha invalida as sessões antigas', () => {
    const token = createSessionToken();
    config.password = 'outra-senha';
    expect(verifySessionToken(token)).toBe(false);
    config.password = PASSWORD;
    expect(verifySessionToken(token)).toBe(true);
  });

  it('limita tentativas seguidas de senha errada', async () => {
    for (let i = 0; i < 8; i++) await call('/auth/login', { method: 'POST', body: { password: `x${i}` } });
    const blocked = await call('/auth/login', { method: 'POST', body: { password: PASSWORD } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('lê o cookie de sessão do cabeçalho cru (WebSocket da voz)', () => {
    const token = createSessionToken();
    const header = `tema=escuro; ${SESSION_COOKIE}=${encodeURIComponent(token)}; outro=1`;
    expect(verifySessionToken(readCookieFromHeader(header, SESSION_COOKIE))).toBe(true);
    expect(readCookieFromHeader(undefined, SESSION_COOKIE)).toBeNull();
  });
});

describe('segurança na inicialização', () => {
  it('recusa expor o Lärk na rede sem senha', () => {
    expect(startupSecurityProblem('0.0.0.0', '')).toMatch(/LARK_PASSWORD/);
    expect(startupSecurityProblem('192.168.0.10', '')).toBeTruthy();
    expect(startupSecurityProblem('0.0.0.0', 'senha')).toBeNull();
    expect(startupSecurityProblem('127.0.0.1', '')).toBeNull();
    expect(startupSecurityProblem('localhost', '')).toBeNull();
    expect(startupSecurityProblem('::1', '')).toBeNull();
  });

  it('reconhece endereços de loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.2')).toBe(false);
  });
});
