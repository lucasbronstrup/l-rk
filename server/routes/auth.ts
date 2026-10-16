/**
 * Autenticação por senha (quando LARK_PASSWORD está definida).
 *  - GET  /auth/status → {required, authenticated}
 *  - POST /auth/login {password} → {required, authenticated} + cookie de sessão (30 dias)
 *  - POST /auth/logout → {required, authenticated:false}
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  checkPassword,
  clearLoginFailures,
  clearSessionCookie,
  isAuthRequired,
  isRequestAuthenticated,
  issueSessionCookie,
  loginRetryAfter,
  recordLoginFailure,
} from '../lib/auth.js';
import { fail, parseBody } from './http.js';

const loginSchema = z.object({
  password: z.string({ error: 'Informe a senha.' }).min(1, 'Informe a senha.').max(1024, 'Senha longa demais.'),
});

export const authRoutes = new Hono();

authRoutes.get('/auth/status', (c) => {
  c.header('Cache-Control', 'no-store');
  const required = isAuthRequired();
  return c.json({ required, authenticated: !required || isRequestAuthenticated(c) });
});

authRoutes.post('/auth/login', async (c) => {
  if (!isAuthRequired()) return c.json({ required: false, authenticated: true });
  const wait = loginRetryAfter(c);
  if (wait > 0) {
    c.header('Retry-After', String(wait));
    return fail(c, 429, `Muitas tentativas erradas. Respire fundo e tente de novo em ${Math.ceil(wait / 60)} min.`);
  }
  const body = await parseBody(c, loginSchema);
  if ('response' in body) return body.response;
  if (!checkPassword(body.data.password)) {
    recordLoginFailure(c);
    return fail(c, 401, 'Senha incorreta.');
  }
  clearLoginFailures(c);
  issueSessionCookie(c);
  return c.json({ required: true, authenticated: true });
});

authRoutes.post('/auth/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ required: isAuthRequired(), authenticated: !isAuthRequired() });
});
