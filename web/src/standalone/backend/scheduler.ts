/**
 * Proatividade enquanto a página está aberta (a cada 15 s):
 *  - lembretes vencidos → reminder_fired com fala do Lärk (e reagenda a recorrência);
 *  - promessas vencidas → checkin, respeitando o intervalo de horas e o horário de silêncio.
 */
import type { ChatMessage, Commitment, Reminder } from '@shared/types';
import { bus } from './bus';
import { addMessage, getDueReminders, getOrCreateActiveConversation, getSettings, listCommitments, updateCommitment, updateReminder } from './db';
import { formatLocalTime, formatRelative, inQuietHours, nextOccurrenceAfter, safeTimeZone } from './time';
import { nowIso, truncate } from './util';

const TICK_MS = 15_000;
let timer: number | undefined;

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function reminderSpeech(r: Reminder, tz: string, now: Date): string {
  const late = now.getTime() - Date.parse(r.dueAt) > 10 * 60_000;
  const name = getSettings().userName.trim();
  const call = name ? `${name}, ` : '';
  const text = r.text.trim().replace(/[.!?…]+$/, '');
  if (late) {
    return `${call}lembrete atrasado — era para ${formatRelative(r.dueAt, tz, now)}: **${text}**. Antes tarde do que nunca. Ainda dá tempo?`;
  }
  return pick([
    `${call}hora marcada: **${text}**. O combinado de antes é o compromisso de agora. Bora?`,
    `${call}lembrete: **${text}**. Quem cumpre o pequeno se acostuma a cumprir o grande.`,
    `${call}${formatLocalTime(r.dueAt, tz)} em ponto: **${text}**. O Freio vai sugerir "daqui a pouco". Você sabe o que responder.`,
  ]);
}

function checkinSpeech(c: Commitment, tz: string, now: Date): string {
  const name = getSettings().userName.trim();
  const call = name ? `${name}, ` : '';
  const desc = truncate(c.description.replace(/[.!?…]+$/, ''), 160);
  const due = c.dueAt ? ` O prazo era ${formatRelative(c.dueAt, tz, now)}.` : '';
  if (c.checkCount >= 2) {
    return `${call}terceira vez que eu toco no assunto: **${desc}**.${due} Sem julgamento — só quero saber se mantemos, adiamos ou encerramos. Qual vai ser?`;
  }
  return pick([
    `${call}e aquela promessa: **${desc}**?${due} Cumpriu? Me conta que eu atualizo.`,
    `${call}prestação de contas, versão amigável: **${desc}**.${due} Feito, adiado ou o Freio ganhou essa?`,
  ]);
}

function proactiveMessage(content: string): ChatMessage {
  const conv = getOrCreateActiveConversation();
  return addMessage({ conversationId: conv.id, role: 'assistant', content, kind: 'proactive', createdAt: nowIso() });
}

export function tick(now = new Date()): void {
  const settings = getSettings();
  const tz = safeTimeZone(settings.timezone);

  for (const r of getDueReminders(now)) {
    const message = proactiveMessage(reminderSpeech(r, tz, now));
    const next = r.recurrence !== 'none' ? nextOccurrenceAfter(r.dueAt, r.recurrence, tz, now) : null;
    const updated = next
      ? updateReminder(r.id, { dueAt: next, status: 'scheduled', firedAt: now.toISOString() }, { silent: true })
      : updateReminder(r.id, { status: 'fired', firedAt: now.toISOString() }, { silent: true });
    if (updated) bus.publish({ type: 'reminder_fired', reminder: updated, message });
  }

  const p = settings.proactive;
  if (!p.enabled || inQuietHours(now, tz, p.quietHoursStart, p.quietHoursEnd)) return;
  const everyMs = Math.max(0.25, p.checkInEveryHours) * 3600_000;
  const due = listCommitments({ status: 'open' }).find((c) => {
    if (!c.dueAt || Date.parse(c.dueAt) > now.getTime()) return false;
    const last = c.lastCheckedAt ? Date.parse(c.lastCheckedAt) : 0;
    return now.getTime() - last >= everyMs;
  });
  if (due) {
    const message = proactiveMessage(checkinSpeech(due, tz, now));
    const updated = updateCommitment(due.id, { lastCheckedAt: now.toISOString(), checkCount: due.checkCount + 1 });
    if (updated) bus.publish({ type: 'checkin', commitment: updated, message });
  }
}

export function startScheduler(): void {
  if (timer !== undefined) return;
  const safeTick = () => {
    try {
      tick();
    } catch (e) {
      console.warn('[Lärk web] Falha no agendador:', e);
    }
  };
  window.setTimeout(safeTick, 4000);
  timer = window.setInterval(safeTick, TICK_MS);
  // Voltou para a aba: confere na hora (os timers ficam lentos em segundo plano).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') safeTick();
  });
}
