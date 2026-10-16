/**
 * Conversas e histórico de mensagens.
 *  GET /conversations?limit= · POST /conversations {title?} · GET /conversations/active
 *  GET/PATCH/DELETE /conversations/:id · GET /conversations/:id/messages?limit=&before=
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createConversation,
  deleteConversation,
  getConversation,
  getOrCreateActiveConversation,
  listConversations,
  updateConversation,
} from '../memory/conversations.js';
import { listMessages } from '../memory/messages.js';
import { abortChatTurn } from './chat.js';
import { fail, parseBody, parseQuery, queryInt, runValidated } from './http.js';

const createSchema = z.object({
  title: z.string({ error: 'O título deve ser um texto.' }).max(200, 'Título longo demais (máx. 200 caracteres).').optional(),
});

const patchSchema = z
  .object({
    title: z.string({ error: 'O título deve ser um texto.' }).trim().min(1, 'O título não pode ficar vazio.').max(200, 'Título longo demais (máx. 200 caracteres).').optional(),
    summary: z.string({ error: 'O resumo deve ser um texto.' }).max(20_000, 'Resumo longo demais.').nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.summary !== undefined, 'Nada para atualizar: envie "title" ou "summary".');

const listQuery = z.object({ limit: queryInt(1, 1000) });
const messagesQuery = z.object({
  limit: queryInt(1, 1000),
  before: z
    .string()
    .optional()
    .refine((v) => !v || !Number.isNaN(new Date(v).getTime()), 'Parâmetro "before" inválido: use uma data ISO-8601.'),
});

export const conversationRoutes = new Hono();

conversationRoutes.get('/conversations', (c) => {
  const q = parseQuery(c, listQuery);
  if ('response' in q) return q.response;
  return c.json(listConversations(q.data.limit ?? 50));
});

conversationRoutes.post('/conversations', async (c) => {
  const body = await parseBody(c, createSchema);
  if ('response' in body) return body.response;
  return c.json(createConversation(body.data.title), 201);
});

conversationRoutes.get('/conversations/active', (c) => c.json(getOrCreateActiveConversation()));

conversationRoutes.get('/conversations/:id', (c) => {
  const conversation = getConversation(c.req.param('id'));
  return conversation ? c.json(conversation) : fail(c, 404, 'Conversa não encontrada.');
});

conversationRoutes.patch('/conversations/:id', async (c) => {
  const body = await parseBody(c, patchSchema);
  if ('response' in body) return body.response;
  const result = runValidated(c, () => updateConversation(c.req.param('id'), body.data));
  if ('response' in result) return result.response;
  return result.value ? c.json(result.value) : fail(c, 404, 'Conversa não encontrada.');
});

conversationRoutes.delete('/conversations/:id', (c) => {
  const id = c.req.param('id');
  abortChatTurn(id, 'A conversa foi apagada.');
  return deleteConversation(id) ? c.json({ ok: true }) : fail(c, 404, 'Conversa não encontrada.');
});

conversationRoutes.get('/conversations/:id/messages', (c) => {
  const id = c.req.param('id');
  if (!getConversation(id)) return fail(c, 404, 'Conversa não encontrada.');
  const q = parseQuery(c, messagesQuery);
  if ('response' in q) return q.response;
  return c.json(listMessages(id, { limit: q.data.limit ?? 100, before: q.data.before || undefined }));
});
