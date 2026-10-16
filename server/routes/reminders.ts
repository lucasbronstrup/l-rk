/**
 * Lembretes com hora marcada (e recorrência).
 *  GET /reminders?status=&from=&to= · POST /reminders · GET/PATCH/DELETE /reminders/:id
 * Adiar = PATCH {dueAt} (um lembrete já disparado volta a 'scheduled' automaticamente).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  RECURRENCES,
  REMINDER_STATUSES,
  createReminder,
  deleteReminder,
  getReminder,
  listReminders,
  updateReminder,
} from '../memory/reminders.js';
import { getSettings } from '../memory/settings.js';
import { dateText, fail, parseBody, parseQuery, runValidated, toUtcIso } from './http.js';
import type { Recurrence, Reminder, ReminderStatus } from '../../shared/types.js';

const statusSchema = z.enum(REMINDER_STATUSES as [ReminderStatus, ...ReminderStatus[]], {
  error: 'Status inválido: use scheduled, fired, dismissed ou cancelled.',
});
const recurrenceSchema = z.enum(RECURRENCES as [Recurrence, ...Recurrence[]], {
  error: 'Recorrência inválida: use none, daily, weekdays, weekly ou monthly.',
});
const textSchema = z
  .string({ error: 'Escreva o texto do lembrete.' })
  .trim()
  .min(1, 'Escreva o texto do lembrete.')
  .max(1000, 'Texto do lembrete longo demais (máx. 1000 caracteres).');

const createSchema = z.object({
  text: textSchema,
  dueAt: dateText('a data do lembrete'),
  recurrence: recurrenceSchema.optional(),
});

const patchSchema = z
  .object({
    text: textSchema.optional(),
    dueAt: dateText('a data do lembrete').optional(),
    status: statusSchema.optional(),
    recurrence: recurrenceSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nada para atualizar.');

const listQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(statusSchema.optional()),
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
});

export const reminderRoutes = new Hono();

reminderRoutes.get('/reminders', (c) => {
  const q = parseQuery(c, listQuery);
  if ('response' in q) return q.response;
  const tz = getSettings().timezone;
  const result = runValidated(c, () =>
    listReminders({
      status: q.data.status,
      from: q.data.from ? toUtcIso(q.data.from, tz) : undefined,
      to: q.data.to ? toUtcIso(q.data.to, tz) : undefined,
    }),
  );
  if ('response' in result) return result.response;
  return c.json(result.value);
});

reminderRoutes.post('/reminders', async (c) => {
  const body = await parseBody(c, createSchema);
  if ('response' in body) return body.response;
  const tz = getSettings().timezone;
  const result = runValidated(c, () =>
    createReminder({ text: body.data.text, dueAt: toUtcIso(body.data.dueAt, tz), recurrence: body.data.recurrence }),
  );
  if ('response' in result) return result.response;
  return c.json(result.value, 201);
});

reminderRoutes.get('/reminders/:id', (c) => {
  const reminder = getReminder(c.req.param('id'));
  return reminder ? c.json(reminder) : fail(c, 404, 'Lembrete não encontrado.');
});

reminderRoutes.patch('/reminders/:id', async (c) => {
  const id = c.req.param('id');
  const current = getReminder(id);
  if (!current) return fail(c, 404, 'Lembrete não encontrado.');
  const body = await parseBody(c, patchSchema);
  if ('response' in body) return body.response;
  const tz = getSettings().timezone;
  const result = runValidated(c, () => {
    const patch: Partial<Pick<Reminder, 'text' | 'dueAt' | 'status' | 'recurrence' | 'firedAt'>> = { ...body.data };
    if (body.data.dueAt !== undefined) {
      patch.dueAt = toUtcIso(body.data.dueAt, tz);
      // Adiar um lembrete que já disparou: volta para a agenda.
      if (body.data.status === undefined && current.status === 'fired' && new Date(patch.dueAt).getTime() > Date.now()) {
        patch.status = 'scheduled';
      }
    }
    if (patch.status === 'scheduled' && current.status !== 'scheduled') patch.firedAt = null;
    return updateReminder(id, patch);
  });
  if ('response' in result) return result.response;
  return result.value ? c.json(result.value) : fail(c, 404, 'Lembrete não encontrado.');
});

reminderRoutes.delete('/reminders/:id', (c) =>
  deleteReminder(c.req.param('id')) ? c.json({ ok: true }) : fail(c, 404, 'Lembrete não encontrado.'),
);
