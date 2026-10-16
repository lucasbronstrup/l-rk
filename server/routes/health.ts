/**
 * Saúde do servidor e catálogo de modelos.
 *  - GET /health → HealthInfo (público, mesmo com senha: a interface usa para saber se precisa de login).
 *  - GET /models?refresh=1 → ModelInfo[] disponíveis para a chave atual.
 */
import os from 'node:os';
import { Hono } from 'hono';
import { config } from '../config.js';
import { getApiKey } from '../memory/settings.js';
import { classifyGeminiError, getActiveModels, listAvailableModels } from '../llm/gemini.js';
import { isAuthRequired } from '../lib/auth.js';
import { fail } from './http.js';
import type { HealthInfo, ModelRole } from '../../shared/types.js';

/** Tempo máximo para resolver os modelos ativos no /health (a listagem pode estar lenta ou fora do ar). */
const ACTIVE_MODELS_TIMEOUT_MS = 2_500;

let lastActiveModels: Partial<Record<ModelRole, string>> = {};

/** Modelos ativos com tolerância a falhas: em timeout/erro devolve o último resultado conhecido. */
async function activeModelsSafely(): Promise<Partial<Record<ModelRole, string>>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      getActiveModels(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ACTIVE_MODELS_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (result) lastActiveModels = result;
    return result ?? lastActiveModels;
  } catch {
    return lastActiveModels;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const healthRoutes = new Hono();

healthRoutes.get('/health', async (c) => {
  const hasApiKey = Boolean(getApiKey());
  const health: HealthInfo = {
    ok: true,
    version: config.version,
    mock: config.mock,
    hasApiKey,
    activeModels: hasApiKey || config.mock ? await activeModelsSafely() : {},
    platform: process.platform,
    hostname: os.hostname(),
    authRequired: isAuthRequired(),
  };
  c.header('Cache-Control', 'no-store');
  return c.json(health);
});

healthRoutes.get('/models', async (c) => {
  const refresh = ['1', 'true', 'sim'].includes((c.req.query('refresh') ?? '').toLowerCase());
  try {
    return c.json(await listAvailableModels(refresh));
  } catch (error) {
    const { message } = classifyGeminiError(error);
    return fail(c, 502, message);
  }
});
