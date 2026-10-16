import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  process.env.LARK_MOCK = '1';
});

import { db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { streamEvents, subscriberCount } from '../lib/sse.js';
import { createCommitment, getCommitment } from '../memory/commitments.js';
import { createReminder, getReminder } from '../memory/reminders.js';
import { listMessages } from '../memory/messages.js';
import { getOrCreateActiveConversation } from '../memory/conversations.js';
import { updateSettings, writeSettingValue } from '../memory/settings.js';
import { runSchedulerTick } from './scheduler.js';
import { AUTO_MISSED_NOTE, isQuietTime, runCheckins } from './checkins.js';
import { getLastBriefing, requestBriefing } from './briefing.js';
import { Hono } from 'hono';
import type { LarkEvent } from '../../shared/types.js';

// São Paulo não tem horário de verão desde 2019: UTC−3 fixo, o que deixa as contas previsíveis.
const TZ = 'America/Sao_Paulo';
/** Instante UTC a partir de um horário local de São Paulo ("2030-03-10T12:00"). */
const sp = (local: string) => new Date(`${local}:00-03:00`);

let events: LarkEvent[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  db.exec(
    "DELETE FROM messages; DELETE FROM conversations; DELETE FROM commitments; DELETE FROM reminders; DELETE FROM settings WHERE key = 'proactive.lastBriefing';",
  );
  updateSettings({
    timezone: TZ,
    userName: 'Lucas',
    proactive: { enabled: true, checkInEveryHours: 6, quietHoursStart: '23:00', quietHoursEnd: '07:00', morningBriefing: true },
  });
  events = [];
  unsubscribe = bus.subscribe((e) => events.push(e));
});
afterEach(() => unsubscribe());

describe('lembretes', () => {
  it('lembrete vencido dispara uma vez, vira "fired" e gera fala proativa', async () => {
    const now = sp('2030-03-10T09:00');
    const reminder = createReminder({ text: 'Tomar o remédio', dueAt: sp('2030-03-10T08:59').toISOString() });

    const result = await runSchedulerTick(now);
    expect(result.reminders).toHaveLength(1);
    const after = getReminder(reminder.id)!;
    expect(after.status).toBe('fired');
    expect(after.firedAt).toBe(now.toISOString());

    const fired = events.find((e) => e.type === 'reminder_fired');
    expect(fired && fired.type === 'reminder_fired' && fired.message?.content).toMatch(/⏰ Lembrete, Lucas: Tomar o remédio/);
    const messages = listMessages(getOrCreateActiveConversation().id);
    expect(messages.at(-1)?.kind).toBe('proactive');

    // Não dispara de novo no próximo ciclo.
    expect((await runSchedulerTick(new Date(now.getTime() + 20_000))).reminders).toHaveLength(0);
  });

  it('lembrete futuro não dispara', async () => {
    createReminder({ text: 'Reunião', dueAt: sp('2030-03-10T15:00').toISOString() });
    expect((await runSchedulerTick(sp('2030-03-10T14:59'))).reminders).toHaveLength(0);
  });

  it('recorrente é reagendado para a próxima ocorrência futura (mesmo horário local)', async () => {
    const reminder = createReminder({ text: 'Meditar', dueAt: sp('2030-03-08T07:30').toISOString(), recurrence: 'daily' });
    // Servidor ficou desligado dois dias: dispara uma vez e pula as ocorrências perdidas.
    const now = sp('2030-03-10T08:00');
    await runSchedulerTick(now);
    const after = getReminder(reminder.id)!;
    expect(after.status).toBe('scheduled');
    expect(after.dueAt).toBe(sp('2030-03-11T07:30').toISOString());
    expect(after.firedAt).toBe(now.toISOString());
    const fired = events.filter((e) => e.type === 'reminder_fired');
    expect(fired).toHaveLength(1);
    // Atrasado: a fala menciona o horário original.
    expect(fired[0].type === 'reminder_fired' && fired[0].message?.content).toMatch(/estava marcado para/);
  });

  it('dispara mesmo no horário silencioso', async () => {
    createReminder({ text: 'Acordar para o voo', dueAt: sp('2030-03-10T04:00').toISOString() });
    expect((await runSchedulerTick(sp('2030-03-10T04:00'))).reminders).toHaveLength(1);
  });
});

describe('cobranças de promessas', () => {
  it('horário silencioso cruzando a meia-noite', () => {
    const settings = { timezone: TZ, proactive: { enabled: true, checkInEveryHours: 6, quietHoursStart: '23:00', quietHoursEnd: '07:00', morningBriefing: true } };
    expect(isQuietTime(sp('2030-03-10T23:30'), settings)).toBe(true);
    expect(isQuietTime(sp('2030-03-10T03:00'), settings)).toBe(true);
    expect(isQuietTime(sp('2030-03-10T07:00'), settings)).toBe(false);
    expect(isQuietTime(sp('2030-03-10T22:59'), settings)).toBe(false);
    const day = { ...settings, proactive: { ...settings.proactive, quietHoursStart: '12:00', quietHoursEnd: '14:00' } };
    expect(isQuietTime(sp('2030-03-10T13:00'), day)).toBe(true);
    expect(isQuietTime(sp('2030-03-10T15:00'), day)).toBe(false);
  });

  it('respeita o intervalo, o horário silencioso e o limite de 3 cobranças', async () => {
    const c = createCommitment({ description: 'Entregar o relatório', dueAt: sp('2030-03-10T12:00').toISOString() });

    // Antes do prazo: nada.
    expect(await runCheckins(sp('2030-03-10T11:00'))).toBeNull();

    // Venceu: primeira cobrança.
    const first = await runCheckins(sp('2030-03-10T12:30'));
    expect(first?.commitment.checkCount).toBe(1);
    expect(first?.message.content).toContain('Entregar o relatório');
    expect(events.some((e) => e.type === 'checkin')).toBe(true);

    // Dentro do intervalo de 6 h: nada.
    expect(await runCheckins(sp('2030-03-10T15:00'))).toBeNull();

    // Intervalo cumprido, mas no horário silencioso: nada.
    expect(await runCheckins(sp('2030-03-11T02:00'))).toBeNull();

    // Fora do silêncio: segunda e terceira (a última sugere marcar como não cumprida).
    expect((await runCheckins(sp('2030-03-11T08:00')))?.commitment.checkCount).toBe(2);
    const third = await runCheckins(sp('2030-03-11T14:00'));
    expect(third?.commitment.checkCount).toBe(3);
    expect(third?.message.content).toMatch(/não cumprida|renegocia/);

    // Depois de 3 cobranças, silêncio.
    expect(await runCheckins(sp('2030-03-12T14:00'))).toBeNull();
    expect(getCommitment(c.id)?.status).toBe('pending');

    // Vencida há mais de 7 dias sem resposta: marcada como não cumprida, com nota.
    await runCheckins(sp('2030-03-18T12:31'));
    const missed = getCommitment(c.id)!;
    expect(missed.status).toBe('missed');
    expect(missed.notes).toContain(AUTO_MISSED_NOTE);
  });

  it('sem prazo: só cobra 24 h depois de prometer', async () => {
    const created = createCommitment({ description: 'Ligar para o dentista' });
    const createdAt = new Date(created.createdAt);
    const at = (h: number) => new Date(createdAt.getTime() + h * 3_600_000);
    // Garante que o teste não caia no horário silencioso independentemente da hora real.
    updateSettings({ proactive: { quietHoursStart: '00:00', quietHoursEnd: '00:00' } });
    expect(await runCheckins(at(23))).toBeNull();
    expect((await runCheckins(at(25)))?.commitment.id).toBe(created.id);
  });

  it('no máximo uma cobrança por ciclo, e nenhuma com as cobranças pausadas', async () => {
    createCommitment({ description: 'Promessa A', dueAt: sp('2030-03-10T10:00').toISOString() });
    createCommitment({ description: 'Promessa B', dueAt: sp('2030-03-10T11:00').toISOString() });
    const now = sp('2030-03-10T12:00');

    updateSettings({ proactive: { enabled: false } });
    expect((await runSchedulerTick(now)).checkin).toBeNull();

    updateSettings({ proactive: { enabled: true } });
    const tick = await runSchedulerTick(now);
    expect(tick.checkin?.commitment.description).toBe('Promessa A');
    expect(events.filter((e) => e.type === 'checkin')).toHaveLength(1);
    const next = await runSchedulerTick(new Date(now.getTime() + 20_000));
    expect(next.checkin?.commitment.description).toBe('Promessa B');
  });
});

describe('briefing matinal', () => {
  it('só gera automaticamente com alguém conectado, fora do silêncio e uma vez por dia', async () => {
    expect((await runSchedulerTick(sp('2030-03-10T08:00'))).briefing).toBeNull();

    const app = new Hono().get('/events', (c) => streamEvents(c));
    const res = await app.request('/events');
    const reader = res.body!.getReader();
    await reader.read();
    expect(subscriberCount()).toBe(1);

    try {
      expect((await runSchedulerTick(sp('2030-03-10T06:00'))).briefing).toBeNull(); // silêncio

      const tick = await runSchedulerTick(sp('2030-03-10T08:00'));
      expect(tick.briefing?.kind).toBe('briefing');
      expect(tick.briefing?.content).toMatch(/Bom dia, Lucas/);
      expect(getLastBriefing()?.localDate).toBe('2030-03-10');

      expect((await runSchedulerTick(sp('2030-03-10T16:00'))).briefing).toBeNull(); // já houve hoje
      expect((await runSchedulerTick(sp('2030-03-11T07:05'))).briefing?.content).toMatch(/Bom dia/); // dia seguinte
    } finally {
      await reader.cancel();
    }
  });

  it('inclui a agenda de hoje e as promessas atrasadas', async () => {
    createReminder({ text: 'Dentista', dueAt: sp('2030-03-10T15:00').toISOString() });
    createReminder({ text: 'Amanhã não entra', dueAt: sp('2030-03-11T15:00').toISOString() });
    createCommitment({ description: 'Pagar o boleto', dueAt: sp('2030-03-09T18:00').toISOString() });
    const message = await requestBriefing({ now: sp('2030-03-10T08:00'), force: true });
    expect(message.content).toContain('15:00 — Dentista');
    expect(message.content).not.toContain('Amanhã não entra');
    expect(message.content).toContain('Pagar o boleto');
    expect(events.some((e) => e.type === 'message' && e.message.id === message.id)).toBe(true);
  });

  it('pedido sem force reaproveita o último se tiver menos de 6 h', async () => {
    const first = await requestBriefing({ now: sp('2030-03-10T08:00') });
    const again = await requestBriefing({ now: sp('2030-03-10T13:00') });
    expect(again.id).toBe(first.id);
    const later = await requestBriefing({ now: sp('2030-03-10T14:30') });
    expect(later.id).not.toBe(first.id);
    writeSettingValue('proactive.lastBriefing', null);
  });
});
