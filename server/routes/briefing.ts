/**
 * Briefing do dia.
 *  POST /briefing {conversationId?, force?} → {message: ChatMessage | null}
 *  Sem `force`, só gera um novo se o último tiver mais de 6 h; senão devolve o último.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getConversation } from '../memory/conversations.js';
import { getSettings } from '../memory/settings.js';
import { requestBriefing } from '../proactive/briefing.js';
import { classifyGeminiError } from '../llm/gemini.js';
import { fail, parseBody } from './http.js';

const bodySchema = z.object({
  conversationId: z.string({ error: 'Conversa inválida.' }).trim().min(1).max(200).nullish(),
  force: z.boolean({ error: '"force" deve ser verdadeiro ou falso.' }).optional(),
});

export const briefingRoutes = new Hono();

briefingRoutes.post('/briefing', async (c) => {
  const body = await parseBody(c, bodySchema);
  if ('response' in body) return body.response;
  const { conversationId, force } = body.data;
  if (conversationId && !getConversation(conversationId)) return fail(c, 404, 'Conversa não encontrada.');
  // Sem pedido explícito, respeita a preferência do usuário pelo briefing matinal.
  if (!force && !getSettings().proactive.morningBriefing) return c.json({ message: null });
  try {
    const message = await requestBriefing({ conversationId: conversationId ?? undefined, force: Boolean(force) });
    return c.json({ message });
  } catch (error) {
    const { message } = classifyGeminiError(error);
    return fail(c, 500, message);
  }
});
