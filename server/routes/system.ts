/**
 * Sinais vitais do computador (painel do sistema).
 *  GET /system/vitals → SystemVitals
 */
import { Hono } from 'hono';
import { getSystemVitals } from '../tools/system.js';
import { errorText, fail } from './http.js';

export const systemRoutes = new Hono();

systemRoutes.get('/system/vitals', async (c) => {
  try {
    c.header('Cache-Control', 'no-store');
    return c.json(await getSystemVitals());
  } catch (error) {
    console.warn('[sistema] falha ao ler os sinais vitais:', errorText(error));
    return fail(c, 500, 'Não consegui ler os sinais vitais do computador agora.');
  }
});
