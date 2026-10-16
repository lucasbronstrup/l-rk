/**
 * Configurações do Lärk.
 *  GET /settings → Settings (a chave da API nunca sai do servidor; só `hasApiKey`)
 *  PUT /settings → merge profundo de SettingsUpdate; 400 com mensagem clara se algo for inválido.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { SettingsValidationError, getSettings, updateSettings } from '../memory/settings.js';
import { errorText, fail, parseBody } from './http.js';
import type { SettingsUpdate } from '../../shared/types.js';

/** A validação detalhada é feita por updateSettings; aqui só garantimos um objeto JSON. */
const bodySchema = z.record(z.string(), z.unknown(), { error: 'Envie um objeto JSON com as configurações.' });

export const settingsRoutes = new Hono();

settingsRoutes.get('/settings', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(getSettings());
});

settingsRoutes.put('/settings', async (c) => {
  const body = await parseBody(c, bodySchema);
  if ('response' in body) return body.response;
  try {
    return c.json(updateSettings(body.data as SettingsUpdate));
  } catch (error) {
    if (error instanceof SettingsValidationError) return fail(c, 400, error.message);
    if (error instanceof Error && error.name !== 'SqliteError') return fail(c, 400, errorText(error));
    throw error;
  }
});
