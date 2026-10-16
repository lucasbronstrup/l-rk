/**
 * Briefing do dia: a "abertura de palestra" do Lärk — saudação pela hora do dia, agenda de hoje
 * (lembretes), promessas pendentes/atrasadas e um insight para começar com direção (≤ 150 palavras).
 *
 * - `generateBriefing()` sempre gera um novo e o registra na conversa (kind 'briefing').
 * - `requestBriefing()` aplica a regra de frequência: sem `force`, só gera se o último tiver mais de
 *   6 h; senão devolve o último. Chamadas simultâneas compartilham a mesma geração.
 */
import { bus } from '../lib/bus.js';
import { listCommitments } from '../memory/commitments.js';
import { getConversation, getOrCreateActiveConversation } from '../memory/conversations.js';
import { addMessage, getMessage } from '../memory/messages.js';
import { listReminders } from '../memory/reminders.js';
import { getSettings, readSettingValue, writeSettingValue } from '../memory/settings.js';
import { safeTimeZone, wallClockToDate } from '../memory/time.js';
import { composeWithLark, friendlyDateTime, localDateKey, pick, timeLabel, vocative, wallClock } from './compose.js';
import type { ChatMessage, Commitment, Reminder, Settings } from '../../shared/types.js';

/** Intervalo mínimo entre dois briefings sem `force`. */
export const BRIEFING_MIN_INTERVAL_MS = 6 * 60 * 60_000;
const LAST_BRIEFING_KEY = 'proactive.lastBriefing';

export interface LastBriefingInfo {
  at: string;
  messageId: string;
  conversationId: string;
  /** Data local (AAAA-MM-DD, fuso do usuário) em que foi gerado. */
  localDate: string;
}

/** Último briefing registrado (ou null). */
export function getLastBriefing(): LastBriefingInfo | null {
  const value = readSettingValue<LastBriefingInfo>(LAST_BRIEFING_KEY);
  if (!value || typeof value !== 'object' || typeof value.at !== 'string' || typeof value.messageId !== 'string') return null;
  return value;
}

// ─── Coleta do dia ───────────────────────────────────────────────────────

export interface BriefingData {
  greeting: string;
  period: 'madrugada' | 'manhã' | 'tarde' | 'noite';
  todayReminders: Reminder[];
  overdue: Commitment[];
  dueToday: Commitment[];
  openWithoutDue: Commitment[];
}

/** Saudação pela hora local. */
export function greetingFor(hour: number): { greeting: string; period: BriefingData['period'] } {
  if (hour < 5) return { greeting: 'Boa madrugada', period: 'madrugada' };
  if (hour < 12) return { greeting: 'Bom dia', period: 'manhã' };
  if (hour < 18) return { greeting: 'Boa tarde', period: 'tarde' };
  return { greeting: 'Boa noite', period: 'noite' };
}

/** Início e fim do dia local (fuso do usuário) em UTC. */
function localDayBounds(now: Date, timeZone: string): { start: Date; end: Date } {
  const tz = safeTimeZone(timeZone);
  const w = wallClock(now, tz);
  const start = wallClockToDate({ ...w, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
  const end = wallClockToDate({ ...w, hour: 23, minute: 59, second: 59, millisecond: 999 }, tz);
  return { start, end };
}

export function collectBriefingData(now: Date, settings: Settings): BriefingData {
  const tz = settings.timezone;
  const { greeting, period } = greetingFor(wallClock(now, tz).hour);
  const { start, end } = localDayBounds(now, tz);
  const todayReminders = listReminders({ status: 'scheduled', from: start.toISOString(), to: end.toISOString() });
  const pending = listCommitments({ status: 'pending' });
  const todayKey = localDateKey(now, tz);
  const overdue: Commitment[] = [];
  const dueToday: Commitment[] = [];
  const openWithoutDue: Commitment[] = [];
  for (const c of pending) {
    if (!c.dueAt) openWithoutDue.push(c);
    else if (new Date(c.dueAt).getTime() < now.getTime()) overdue.push(c);
    else if (localDateKey(new Date(c.dueAt), tz) === todayKey) dueToday.push(c);
  }
  return { greeting, period, todayReminders, overdue, dueToday, openWithoutDue };
}

// ─── Texto ───────────────────────────────────────────────────────────────

const INSIGHTS = [
  'Um dia extraordinário raramente é feito de feitos extraordinários — é feito de promessas pequenas cumpridas na hora certa.',
  'Quem decide o primeiro passo decide o resto do caminho. Escolha o seu antes que o dia escolha por você.',
  'Clareza é poder: quando você sabe o que importa hoje, o resto vira ruído.',
  'Medo é o ingresso. Pague, entre e assista ao que você é capaz de fazer.',
  'Constância vence intensidade. Faça hoje o que o seu eu de amanhã vai agradecer.',
  'A agenda mostra o que você planejou; as escolhas mostram quem você é.',
];

/** Briefing sem IA (modo demonstração, sem chave ou falha), curto e no tom do Lärk. */
export function briefingTemplate(data: BriefingData, settings: Settings, now: Date): string {
  const tz = settings.timezone;
  const lines: string[] = [];
  lines.push(`**${data.greeting}${vocative(settings)}.** Antes de o dia começar a falar por você, deixa eu te dar o mapa.`);

  if (data.todayReminders.length) {
    const items = data.todayReminders.slice(0, 4).map((r) => `- ${timeLabel(r.dueAt, tz)} — ${r.text}`);
    const more = data.todayReminders.length > 4 ? `\n- …e mais ${data.todayReminders.length - 4}` : '';
    lines.push(`**Agenda de hoje**\n${items.join('\n')}${more}`);
  } else {
    lines.push('**Agenda de hoje:** nenhum lembrete marcado — página em branco, e página em branco é liberdade.');
  }

  const promises: string[] = [];
  for (const c of data.overdue.slice(0, 3)) promises.push(`- ⚠️ ${c.description} (venceu ${friendlyDateTime(c.dueAt!, tz, now)})`);
  for (const c of data.dueToday.slice(0, 3)) promises.push(`- ${c.description} (até ${timeLabel(c.dueAt!, tz)})`);
  if (!promises.length) for (const c of data.openWithoutDue.slice(0, 2)) promises.push(`- ${c.description}`);
  if (promises.length) lines.push(`**Promessas em jogo**\n${promises.join('\n')}`);
  else lines.push('**Promessas:** nenhuma pendente. Ótimo momento para assumir uma que valha a pena.');

  lines.push(`**Pensamento do dia:** ${pick(INSIGHTS, localDateKey(now, tz))} Bora?`);
  return lines.join('\n\n');
}

const BRIEFING_TASK = `Você está abrindo o dia do usuário com um briefing — como a abertura de uma grande palestra.
Escreva em português do Brasil, no MÁXIMO 150 palavras, nesta ordem:
1. Saudação adequada à hora (use a saudação indicada) com uma frase de abertura que prenda a atenção;
2. A agenda de hoje (lembretes) em lista curta com horários — se não houver, diga isso com elegância;
3. As promessas pendentes que importam (atrasadas primeiro), cobrando com tato;
4. Um insight do dia: uma reflexão original e memorável que conecte com o que ele tem pela frente.
Use markdown leve (negrito e listas curtas). Não invente compromissos, horários ou fatos que não estejam nos dados.
Feche com uma frase curta de impacto.`;

function briefingPrompt(data: BriefingData, settings: Settings, now: Date): string {
  const tz = settings.timezone;
  const fmtList = (items: string[]) => (items.length ? items.join('\n') : '(nenhum)');
  return [
    `Saudação: ${data.greeting} (período: ${data.period})`,
    `Agora: ${friendlyDateTime(now.toISOString(), tz, now)}`,
    settings.userName ? `Nome do usuário: ${settings.userName}` : null,
    `Lembretes de hoje:\n${fmtList(data.todayReminders.map((r) => `- ${timeLabel(r.dueAt, tz)} — ${r.text}`))}`,
    `Promessas atrasadas:\n${fmtList(data.overdue.map((c) => `- ${c.description} (prazo: ${friendlyDateTime(c.dueAt!, tz, now)})`))}`,
    `Promessas para hoje:\n${fmtList(data.dueToday.map((c) => `- ${c.description} (até ${timeLabel(c.dueAt!, tz)})`))}`,
    `Promessas sem prazo:\n${fmtList(data.openWithoutDue.slice(0, 5).map((c) => `- ${c.description}`))}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ─── API pública ─────────────────────────────────────────────────────────

/** Gera um briefing agora, registra na conversa (ativa ou indicada) e publica `{type:'message'}`. */
export async function generateBriefing(conversationId?: string, now: Date = new Date()): Promise<ChatMessage> {
  const settings = getSettings();
  const conversation = (conversationId && getConversation(conversationId)) || getOrCreateActiveConversation();
  const data = collectBriefingData(now, settings);
  const content = await composeWithLark({
    task: BRIEFING_TASK,
    prompt: briefingPrompt(data, settings, now),
    fallback: briefingTemplate(data, settings, now),
    maxOutputTokens: 700,
    maxWords: 150,
    settings,
  });
  const message = addMessage({ conversationId: conversation.id, role: 'assistant', content, kind: 'briefing' });
  const info: LastBriefingInfo = {
    at: now.toISOString(),
    messageId: message.id,
    conversationId: conversation.id,
    localDate: localDateKey(now, settings.timezone),
  };
  writeSettingValue(LAST_BRIEFING_KEY, info);
  bus.publish({ type: 'message', message });
  return message;
}

let inflight: Promise<ChatMessage> | null = null;

/**
 * Briefing com regra de frequência: sem `force`, devolve o último se tiver menos de 6 h
 * (e ainda existir); senão gera um novo. Pedidos simultâneos compartilham a mesma geração.
 */
export async function requestBriefing(opts: { conversationId?: string; force?: boolean; now?: Date } = {}): Promise<ChatMessage> {
  if (inflight) return inflight;
  const now = opts.now ?? new Date();
  if (!opts.force) {
    const last = getLastBriefing();
    if (last && now.getTime() - new Date(last.at).getTime() < BRIEFING_MIN_INTERVAL_MS) {
      const message = getMessage(last.messageId);
      if (message) return message;
    }
  }
  inflight = generateBriefing(opts.conversationId, now).finally(() => {
    inflight = null;
  });
  return inflight;
}
