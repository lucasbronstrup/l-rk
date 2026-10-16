/**
 * Memória permanente do Lärk.
 *  GET /memories?q=&category=&limit=&offset= · GET /memories/stats · GET /memories/search?q=&limit=&messages=
 *  POST /memories · GET/PATCH/DELETE /memories/:id
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  MAX_MEMORY_LENGTH,
  MEMORY_CATEGORIES,
  createMemory,
  deleteMemory,
  getMemory,
  getMemoryStats,
  listMemories,
  updateMemory,
} from '../memory/memories.js';
import { searchMemory } from '../memory/search.js';
import { fail, parseBody, parseQuery, queryInt, queryText, runValidated } from './http.js';
import type { MemoryCategory } from '../../shared/types.js';

const categorySchema = z.enum(MEMORY_CATEGORIES as [MemoryCategory, ...MemoryCategory[]], { error: 'Categoria de memória inválida.' });
const contentSchema = z
  .string({ error: 'Escreva o conteúdo da memória.' })
  .trim()
  .min(1, 'A memória está vazia.')
  .max(MAX_MEMORY_LENGTH, `Memória longa demais (máx. ${MAX_MEMORY_LENGTH} caracteres).`);
const importanceSchema = z
  .number({ error: 'A importância deve ser um número de 1 a 5.' })
  .int('A importância deve ser um número inteiro de 1 a 5.')
  .min(1, 'A importância vai de 1 a 5.')
  .max(5, 'A importância vai de 1 a 5.');

const createSchema = z.object({
  content: contentSchema,
  category: categorySchema.default('other'),
  importance: importanceSchema.optional(),
  pinned: z.boolean({ error: '"pinned" deve ser verdadeiro ou falso.' }).optional(),
});

const patchSchema = z
  .object({
    content: contentSchema.optional(),
    category: categorySchema.optional(),
    importance: importanceSchema.optional(),
    pinned: z.boolean({ error: '"pinned" deve ser verdadeiro ou falso.' }).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nada para atualizar.');

const listQuery = z.object({
  q: queryText(500),
  category: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(categorySchema.optional()),
  limit: queryInt(1, 500),
  offset: queryInt(0, 1_000_000),
});

const searchQuery = z.object({
  q: queryText(1000),
  limit: queryInt(1, 50),
  messages: z.string().optional(),
});

export const memoryRoutes = new Hono();

memoryRoutes.get('/memories', (c) => {
  const q = parseQuery(c, listQuery);
  if ('response' in q) return q.response;
  return c.json(listMemories(q.data));
});

memoryRoutes.get('/memories/stats', (c) => c.json(getMemoryStats()));

memoryRoutes.get('/memories/search', async (c) => {
  const q = parseQuery(c, searchQuery);
  if ('response' in q) return q.response;
  if (!q.data.q) return c.json([]);
  const includeMessages = !['0', 'false', 'nao', 'não'].includes((q.data.messages ?? '').toLowerCase());
  return c.json(await searchMemory(q.data.q, { limit: q.data.limit ?? 12, includeMessages }));
});

memoryRoutes.post('/memories', async (c) => {
  const body = await parseBody(c, createSchema);
  if ('response' in body) return body.response;
  const result = runValidated(c, () => createMemory({ ...body.data, source: 'manual' }));
  if ('response' in result) return result.response;
  return c.json(result.value, 201);
});

memoryRoutes.get('/memories/:id', (c) => {
  const memory = getMemory(c.req.param('id'));
  return memory ? c.json(memory) : fail(c, 404, 'Memória não encontrada.');
});

memoryRoutes.patch('/memories/:id', async (c) => {
  const body = await parseBody(c, patchSchema);
  if ('response' in body) return body.response;
  const result = runValidated(c, () => updateMemory(c.req.param('id'), body.data));
  if ('response' in result) return result.response;
  return result.value ? c.json(result.value) : fail(c, 404, 'Memória não encontrada.');
});

memoryRoutes.delete('/memories/:id', (c) =>
  deleteMemory(c.req.param('id')) ? c.json({ ok: true }) : fail(c, 404, 'Memória não encontrada.'),
);
