/**
 * Agendador proativo do Lärk: a cada 20 s (e logo ao iniciar)
 *  1. dispara lembretes vencidos (ou reagenda os recorrentes) com uma fala curta no estilo do orador;
 *  2. faz no máximo uma cobrança de promessa (ver checkins.ts);
 *  3. gera o briefing matinal uma vez por dia, após o horário silencioso, quando há alguém
 *     conectado à interface (ou assim que alguém se conectar).
 *
 * Lembretes são pedidos explícitos do usuário: disparam mesmo no horário silencioso e com as
 * cobranças pausadas. Os ciclos nunca se sobrepõem.
 */
import { bus } from '../lib/bus.js';
import { onSubscriberConnected, subscriberCount } from '../lib/sse.js';
import { getOrCreateActiveConversation } from '../memory/conversations.js';
import { addMessage } from '../memory/messages.js';
import { getDueReminders, nextOccurrenceAfter, updateReminder } from '../memory/reminders.js';
import { getSettings } from '../memory/settings.js';
import { getLastBriefing, requestBriefing } from './briefing.js';
import { isQuietTime, runCheckins, type CheckinResult } from './checkins.js';
import { composeWithLark, friendlyDateTime, localDateKey, pick, timeLabel, vocative } from './compose.js';
import type { ChatMessage, Reminder, Settings } from '../../shared/types.js';

export const SCHEDULER_INTERVAL_MS = 20_000;
/** Atraso a partir do qual a fala do lembrete menciona que ele está atrasado (servidor estava desligado). */
const LATE_THRESHOLD_MS = 10 * 60_000;
/** Limite de lembretes processados por ciclo (o resto fica para o próximo). */
const MAX_REMINDERS_PER_TICK = 10;

// ─── Lembretes ───────────────────────────────────────────────────────────

/** Fala de lembrete sem IA. */
export function reminderTemplate(reminder: Reminder, settings: Settings, now: Date): string {
  const late = now.getTime() - new Date(reminder.dueAt).getTime() > LATE_THRESHOLD_MS;
  const when = late ? ` (estava marcado para ${friendlyDateTime(reminder.dueAt, settings.timezone, now)})` : '';
  const closers = [
    'O tempo não espera — mas sempre recompensa quem chega na hora.',
    'Pequenos compromissos cumpridos constroem grandes reputações.',
    'Você pediu para eu lembrar; agora o palco é seu.',
    'Quem respeita o próprio relógio respeita o próprio futuro.',
  ];
  return `⏰ Lembrete${vocative(settings)}: ${reminder.text}${when}. ${pick(closers, reminder.id + reminder.dueAt)}`;
}

const REMINDER_TASK = `Você está disparando um lembrete que o próprio usuário pediu para você agendar.
Escreva UMA mensagem curta (1 a 2 frases, no máximo 45 palavras) em português do Brasil que:
- comece com "⏰" e deixe o conteúdo do lembrete inequívoco (use as palavras dele);
- tenha a elegância de um orador e uma pequena reflexão que dê energia para agir agora;
- se o lembrete estiver atrasado, mencione o horário original com naturalidade.
Sem títulos, sem listas. Não invente detalhes.`;

async function composeReminderMessage(reminder: Reminder, settings: Settings, now: Date): Promise<string> {
  const late = now.getTime() - new Date(reminder.dueAt).getTime() > LATE_THRESHOLD_MS;
  const prompt = [
    `Lembrete: "${reminder.text}"`,
    `Horário marcado: ${friendlyDateTime(reminder.dueAt, settings.timezone, now)}${late ? ' (atrasado)' : ''}`,
    `Agora: ${timeLabel(now, settings.timezone)}`,
    reminder.recurrence !== 'none' ? 'É um lembrete recorrente.' : null,
  ]
    .filter(Boolean)
    .join('\n');
  return composeWithLark({
    task: REMINDER_TASK,
    prompt,
    fallback: reminderTemplate(reminder, settings, now),
    maxWords: 45,
    maxOutputTokens: 250,
    settings,
  });
}

export interface FiredReminder {
  reminder: Reminder;
  message: ChatMessage | null;
}

/**
 * Processa os lembretes vencidos: únicos viram 'fired' (+ firedAt); recorrentes são reagendados para
 * a próxima ocorrência futura. Para cada um, registra a fala do Lärk e publica `reminder_fired`.
 */
export async function processDueReminders(now: Date = new Date()): Promise<FiredReminder[]> {
  const due = getDueReminders(now).slice(0, MAX_REMINDERS_PER_TICK);
  if (!due.length) return [];
  const settings = getSettings();
  const fired: FiredReminder[] = [];

  for (const reminder of due) {
    // 1) Atualiza o estado ANTES de gerar o texto: nunca dispara duas vezes.
    let updated: Reminder | null;
    try {
      const next = reminder.recurrence !== 'none' ? nextOccurrenceAfter(reminder.dueAt, reminder.recurrence, settings.timezone, now) : null;
      updated = next
        ? updateReminder(reminder.id, { dueAt: next, firedAt: now.toISOString() })
        : updateReminder(reminder.id, { status: 'fired', firedAt: now.toISOString() });
    } catch (error) {
      console.error('[agendador] falha ao atualizar o lembrete', reminder.id, error);
      continue;
    }
    if (!updated) continue;

    // 2) Fala do Lärk (IA curta ou template) registrada na conversa ativa.
    let message: ChatMessage | null = null;
    try {
      const content = await composeReminderMessage(reminder, settings, now);
      const conversation = getOrCreateActiveConversation();
      message = addMessage({ conversationId: conversation.id, role: 'assistant', content, kind: 'proactive' });
    } catch (error) {
      console.error('[agendador] falha ao registrar a fala do lembrete', reminder.id, error);
    }
    bus.publish({ type: 'reminder_fired', reminder: updated, message });
    fired.push({ reminder: updated, message });
  }
  return fired;
}

// ─── Briefing matinal automático ─────────────────────────────────────────

/**
 * Gera o briefing do dia se: briefing matinal ativado, fora do horário silencioso, ainda não houve
 * briefing hoje (data local) e há alguém conectado à interface.
 */
export async function maybeMorningBriefing(now: Date = new Date()): Promise<ChatMessage | null> {
  const settings = getSettings();
  if (!settings.proactive.morningBriefing) return null;
  if (subscriberCount() === 0) return null;
  if (isQuietTime(now, settings)) return null;
  const last = getLastBriefing();
  if (last && last.localDate === localDateKey(now, settings.timezone)) return null;
  return requestBriefing({ now });
}

// ─── Ciclo ───────────────────────────────────────────────────────────────

export interface TickResult {
  reminders: FiredReminder[];
  checkin: CheckinResult | null;
  briefing: ChatMessage | null;
}

let ticking: Promise<TickResult> | null = null;

/** Executa um ciclo completo (exportado para testes, com relógio injetável). Ciclos não se sobrepõem. */
export function runSchedulerTick(now: Date = new Date()): Promise<TickResult> {
  if (ticking) return ticking;
  ticking = (async (): Promise<TickResult> => {
    const result: TickResult = { reminders: [], checkin: null, briefing: null };
    try {
      result.reminders = await processDueReminders(now);
    } catch (error) {
      console.error('[agendador] falha nos lembretes:', error);
    }
    try {
      result.checkin = await runCheckins(now);
    } catch (error) {
      console.error('[agendador] falha nas cobranças:', error);
    }
    try {
      result.briefing = await maybeMorningBriefing(now);
    } catch (error) {
      console.error('[agendador] falha no briefing matinal:', error);
    }
    return result;
  })().finally(() => {
    ticking = null;
  });
  return ticking;
}

let timer: NodeJS.Timeout | null = null;
let startTimer: NodeJS.Timeout | null = null;
let connectTimer: NodeJS.Timeout | null = null;
let unsubscribeConnect: (() => void) | null = null;
let clock: () => Date = () => new Date();

/**
 * Inicia o agendador (idempotente). `opts` existe para testes: relógio e intervalo injetáveis.
 */
export function startScheduler(opts: { now?: () => Date; intervalMs?: number } = {}): void {
  if (timer) return;
  clock = opts.now ?? (() => new Date());
  const intervalMs = Math.max(1000, opts.intervalMs ?? SCHEDULER_INTERVAL_MS);
  const tick = () => {
    void runSchedulerTick(clock());
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // Primeiro ciclo logo após a inicialização (dá um respiro para o servidor terminar de subir).
  startTimer = setTimeout(tick, 1500);
  startTimer.unref?.();
  // "Na próxima conexão": quando alguém abre a interface, confere o briefing do dia.
  unsubscribeConnect = onSubscriberConnected(() => {
    if (connectTimer) return;
    connectTimer = setTimeout(() => {
      connectTimer = null;
      void maybeMorningBriefing(clock()).catch((error: unknown) => console.error('[agendador] falha no briefing matinal:', error));
    }, 2000);
    connectTimer.unref?.();
  });
}

/** Para o agendador (encerramento do servidor e testes). */
export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  if (startTimer) clearTimeout(startTimer);
  if (connectTimer) clearTimeout(connectTimer);
  unsubscribeConnect?.();
  timer = startTimer = connectTimer = null;
  unsubscribeConnect = null;
}

/** Espera o ciclo em andamento terminar (encerramento gracioso). */
export async function waitForSchedulerIdle(): Promise<void> {
  if (ticking) await ticking.catch(() => undefined);
}
