/**
 * Agrega toda a API REST do Lärk (montada sob /api pelo server/index.ts).
 *
 * Ordem dos middlewares: proteção de origem (CSRF / DNS rebinding) → autenticação por senha
 * (quando LARK_PASSWORD existe) → rotas. Erros inesperados viram JSON `{error}` com status 500.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, originGuard } from '../lib/auth.js';
import { approvalRoutes } from './approvals.js';
import { authRoutes } from './auth.js';
import { briefingRoutes } from './briefing.js';
import { chatRoutes } from './chat.js';
import { commitmentRoutes } from './commitments.js';
import { conversationRoutes } from './conversations.js';
import { dataRoutes } from './data.js';
import { eventRoutes } from './events.js';
import { healthRoutes } from './health.js';
import { memoryRoutes } from './memories.js';
import { reminderRoutes } from './reminders.js';
import { settingsRoutes } from './settings.js';
import { systemRoutes } from './system.js';
import { voiceRoutes } from './voice.js';

/** Tratador de erros comum: loga e responde JSON em PT-BR (sem vazar detalhes internos). */
export function handleApiError(error: Error, c: Context): Response {
  if (error instanceof HTTPException && error.status < 500) {
    return c.json({ error: error.message || 'Requisição inválida.' }, error.status);
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return c.json({ error: error.message || 'Requisição inválida.' }, status as 400);
  }
  console.error(`[api] erro em ${c.req.method} ${c.req.path}:`, error);
  return c.json({ error: 'O núcleo do Lärk encontrou um erro interno. Tente novamente em instantes.' }, 500);
}

export const apiRoutes = new Hono();

apiRoutes.onError(handleApiError);
apiRoutes.use('*', originGuard);
apiRoutes.use('*', authMiddleware);

apiRoutes.route('/', healthRoutes);
apiRoutes.route('/', authRoutes);
apiRoutes.route('/', eventRoutes);
apiRoutes.route('/', conversationRoutes);
apiRoutes.route('/', chatRoutes);
apiRoutes.route('/', briefingRoutes);
apiRoutes.route('/', memoryRoutes);
apiRoutes.route('/', commitmentRoutes);
apiRoutes.route('/', reminderRoutes);
apiRoutes.route('/', settingsRoutes);
apiRoutes.route('/', approvalRoutes);
apiRoutes.route('/', systemRoutes);
apiRoutes.route('/', voiceRoutes);
apiRoutes.route('/', dataRoutes);

// Qualquer outra rota da API: 404 em JSON (nunca cai no fallback da interface).
apiRoutes.all('*', (c) => c.json({ error: `Rota da API não encontrada: ${c.req.method} ${c.req.path}` }, 404));
