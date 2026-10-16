/**
 * Promessas (compromissos) que o Lärk cobra.
 *  GET /commitments?status=pending|done|missed|cancelled|open · POST /commitments
 *  GET/PATCH/DELETE /commitments/:id
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  COMMITMENT_STATUSES,
  createCommitment,
  deleteCommitment,
  getCommitment,
  listCommitments,
  updateCommitment,
} from '../memory/commitments.js';
import { getSettings } from '../memory/settings.js';
import { dateText, fail, parseBody, parseQuery, runValidated, toUtcIso } from './http.js';
import type { Commitment, CommitmentStatus } from '../../shared/types.js';

const statusSchema = z.enum(COMMITMENT_STATUSES as [CommitmentStatus, ...CommitmentStatus[]], {
  error: 'Status inválido: use pending, done, missed ou cancelled.',
});
const descriptionSchema = z
  .string({ error: 'Descreva o compromisso.' })
  .trim()
  .min(1, 'Descreva o compromisso.')
  .max(1000, 'Descrição longa demais (máx. 1000 caracteres).');
const notesSchema = z.string({ error: 'As notas devem ser um texto.' }).max(4000, 'Notas longas demais (máx. 4000 caracteres).').nullable();

const createSchema = z.object({
  description: descriptionSchema,
  dueAt: dateText('o prazo').nullable().optional(),
  notes: notesSchema.optional(),
});

const patchSchema = z
  .object({
    description: descriptionSchema.optional(),
    dueAt: dateText('o prazo').nullable().optional(),
    status: statusSchema.optional(),
    notes: notesSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nada para atualizar.');

const listQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.union([statusSchema, z.literal('open')]).optional()),
});

export const commitmentRoutes = new Hono();

commitmentRoutes.get('/commitments', (c) => {
  const q = parseQuery(c, listQuery);
  if ('response' in q) return q.response;
  return c.json(listCommitments({ status: q.data.status }));
});

commitmentRoutes.post('/commitments', async (c) => {
  const body = await parseBody(c, createSchema);
  if ('response' in body) return body.response;
  const tz = getSettings().timezone;
  const result = runValidated(c, () =>
    createCommitment({
      description: body.data.description,
      dueAt: body.data.dueAt ? toUtcIso(body.data.dueAt, tz) : null,
      notes: body.data.notes ?? null,
    }),
  );
  if ('response' in result) return result.response;
  return c.json(result.value, 201);
});

commitmentRoutes.get('/commitments/:id', (c) => {
  const commitment = getCommitment(c.req.param('id'));
  return commitment ? c.json(commitment) : fail(c, 404, 'Compromisso não encontrado.');
});

commitmentRoutes.patch('/commitments/:id', async (c) => {
  const id = c.req.param('id');
  const current = getCommitment(id);
  if (!current) return fail(c, 404, 'Compromisso não encontrado.');
  const body = await parseBody(c, patchSchema);
  if ('response' in body) return body.response;
  const tz = getSettings().timezone;
  const result = runValidated(c, () => {
    const patch: Parameters<typeof updateCommitment>[1] = {};
    if (body.data.description !== undefined) patch.description = body.data.description;
    if (body.data.notes !== undefined) patch.notes = body.data.notes;
    if (body.data.status !== undefined) patch.status = body.data.status;
    if (body.data.dueAt !== undefined) {
      patch.dueAt = body.data.dueAt ? toUtcIso(body.data.dueAt, tz) : null;
      // Prazo novo = conversa nova: as cobranças recomeçam do zero.
      if (patch.dueAt !== current.dueAt) resetCheckins(patch);
    }
    // Reaberto (ex.: estava "não cumprido" e o usuário voltou atrás): também recomeça.
    if (body.data.status === 'pending' && current.status !== 'pending') resetCheckins(patch);
    return updateCommitment(id, patch);
  });
  if ('response' in result) return result.response;
  return result.value ? c.json(result.value) : fail(c, 404, 'Compromisso não encontrado.');
});

function resetCheckins(patch: Partial<Pick<Commitment, 'lastCheckedAt' | 'checkCount'>>): void {
  patch.lastCheckedAt = null;
  patch.checkCount = 0;
}

commitmentRoutes.delete('/commitments/:id', (c) =>
  deleteCommitment(c.req.param('id')) ? c.json({ ok: true }) : fail(c, 404, 'Compromisso não encontrado.'),
);
