/**
 * Rotas REST da voz (montadas sob /api):
 *  - POST /tts {text, voiceName?, style?} → audio/wav com a voz do Lärk (Gemini TTS),
 *    ou 204 sem corpo quando indisponível (modo demonstração, sem chave, cota) — o motivo vai no
 *    cabeçalho X-Lark-TTS-Reason e o cliente usa a voz do navegador.
 *  - GET /voices → vozes pré-definidas do Gemini com descrição em PT-BR.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { synthesizeSpeechDetailed } from '../voice/tts.js';
import { listVoices } from '../voice/voices.js';

/** Limite do corpo aceito (o servidor ainda normaliza e corta em ~4000 caracteres para a fala). */
const MAX_REQUEST_TEXT = 20_000;

const ttsBodySchema = z.object({
  text: z
    .string({ error: 'Envie o texto a ser falado no campo "text".' })
    .min(1, 'O texto para falar está vazio.')
    .max(MAX_REQUEST_TEXT, `O texto para falar passa de ${MAX_REQUEST_TEXT.toLocaleString('pt-BR')} caracteres.`),
  voiceName: z.string().trim().max(64, 'Nome de voz longo demais.').optional(),
  style: z.string().trim().max(1_000, 'A direção de estilo passa de 1.000 caracteres.').optional(),
});

export const voiceRoutes = new Hono();

voiceRoutes.post('/tts', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Corpo inválido: envie um JSON com o campo "text".', code: 'bad_request' }, 400);
  }
  const parsed = ttsBodySchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Dados inválidos para a voz.';
    return c.json({ error: message, code: 'bad_request' }, 400);
  }

  const { text, voiceName, style } = parsed.data;
  const outcome = await synthesizeSpeechDetailed(text, {
    ...(voiceName ? { voiceName } : {}),
    ...(style ? { style } : {}),
  });
  if (!outcome.ok) {
    return c.body(null, 204, { 'X-Lark-TTS-Reason': outcome.reason, 'Cache-Control': 'no-store' });
  }
  return c.body(new Uint8Array(outcome.wav), 200, {
    'Content-Type': 'audio/wav',
    'Cache-Control': 'private, max-age=3600',
    'X-Lark-TTS-Model': outcome.model,
    'X-Lark-TTS-Cache': outcome.cached ? 'hit' : 'miss',
  });
});

voiceRoutes.get('/voices', async (c) => {
  const voices = await listVoices();
  return c.json(voices);
});
