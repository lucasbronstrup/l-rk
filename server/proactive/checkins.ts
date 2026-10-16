/**
 * Cobranças de promessas: o Lärk pergunta, no momento certo e com tato, se o usuário cumpriu
 * o que prometeu.
 *
 * Regras:
 * - Só com `settings.proactive.enabled` e fora do horário silencioso.
 * - Elegível: compromisso 'pending' vencido (ou sem prazo e criado há mais de 24 h), com a última
 *   cobrança mais antiga que `checkInEveryHours`, e com menos de 3 cobranças.
 * - No máximo 1 cobrança por ciclo do agendador; a terceira sugere marcar como não cumprida.
 * - Vencido há mais de 7 dias, após 3 cobranças sem resposta → status 'missed' com nota.
 */
import { bus } from '../lib/bus.js';
import { listCommitments, updateCommitment } from '../memory/commitments.js';
import { getOrCreateActiveConversation } from '../memory/conversations.js';
import { addMessage, listMessages } from '../memory/messages.js';
import { getSettings } from '../memory/settings.js';
import { composeWithLark, friendlyDateTime, minutesOfDay, parseHhmm, pick, vocative } from './compose.js';
import type { ChatMessage, Commitment, Settings } from '../../shared/types.js';

/** Máximo de cobranças por compromisso (a última sugere marcar como não cumprido). */
export const MAX_CHECKINS = 3;
/** Sem prazo: o primeiro "e aí?" vem 24 h depois de prometer. */
export const NO_DUE_GRACE_MS = 24 * 60 * 60_000;
/** Depois de 3 cobranças, quantos dias vencido até ser marcado como não cumprido. */
export const AUTO_MISS_AFTER_MS = 7 * 24 * 60 * 60_000;
/** Não interrompe uma conversa em andamento: espera este silêncio na conversa ativa. */
export const CONVERSATION_IDLE_MS = 2 * 60_000;

export const AUTO_MISSED_NOTE =
  'Marcada automaticamente como não cumprida: venceu há mais de 7 dias e ficou sem resposta após 3 cobranças.';

/** true se `now` está dentro do horário silencioso (suporta intervalos que cruzam a meia-noite). */
export function isQuietTime(now: Date, settings: Pick<Settings, 'proactive' | 'timezone'>): boolean {
  const start = parseHhmm(settings.proactive.quietHoursStart);
  const end = parseHhmm(settings.proactive.quietHoursEnd);
  if (start === null || end === null || start === end) return false;
  const current = minutesOfDay(now, settings.timezone);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Momento a partir do qual a promessa pode ser cobrada (prazo, ou criação + 24 h). */
export function effectiveDueTime(commitment: Commitment): number {
  if (commitment.dueAt) return new Date(commitment.dueAt).getTime();
  return new Date(commitment.createdAt).getTime() + NO_DUE_GRACE_MS;
}

/** true se o compromisso pode ser cobrado agora (ignora horário silencioso). */
export function isCheckinDue(commitment: Commitment, now: Date, settings: Pick<Settings, 'proactive'>): boolean {
  if (commitment.status !== 'pending' || commitment.checkCount >= MAX_CHECKINS) return false;
  const due = effectiveDueTime(commitment);
  if (!Number.isFinite(due) || due > now.getTime()) return false;
  if (!commitment.lastCheckedAt) return true;
  const intervalMs = Math.max(0.25, settings.proactive.checkInEveryHours) * 3_600_000;
  return now.getTime() - new Date(commitment.lastCheckedAt).getTime() >= intervalMs;
}

/** Escolhe a próxima promessa a cobrar: a menos cobrada recentemente e, no empate, a mais atrasada. */
export function selectCommitmentForCheckin(
  commitments: Commitment[],
  now: Date,
  settings: Pick<Settings, 'proactive'>,
): Commitment | null {
  const due = commitments.filter((c) => isCheckinDue(c, now, settings));
  if (!due.length) return null;
  due.sort((a, b) => {
    const la = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
    const lb = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
    return la - lb || effectiveDueTime(a) - effectiveDueTime(b);
  });
  return due[0];
}

/** Marca como 'missed' as promessas abandonadas (vencidas há > 7 dias após 3 cobranças). */
export function markAbandonedCommitments(now: Date, settings: Pick<Settings, 'proactive'>): Commitment[] {
  const intervalMs = Math.max(0.25, settings.proactive.checkInEveryHours) * 3_600_000;
  const missed: Commitment[] = [];
  for (const c of listCommitments({ status: 'pending' })) {
    if (c.checkCount < MAX_CHECKINS) continue;
    if (now.getTime() - effectiveDueTime(c) <= AUTO_MISS_AFTER_MS) continue;
    // Dá ao usuário o intervalo normal para responder à última cobrança.
    if (c.lastCheckedAt && now.getTime() - new Date(c.lastCheckedAt).getTime() < intervalMs) continue;
    const notes = c.notes ? `${c.notes}\n\n${AUTO_MISSED_NOTE}` : AUTO_MISSED_NOTE;
    const updated = updateCommitment(c.id, { status: 'missed', notes });
    if (updated) missed.push(updated);
  }
  return missed;
}

function conversationIsBusy(conversationId: string, now: Date): boolean {
  const [last] = listMessages(conversationId, { limit: 1 });
  if (!last || last.kind === 'proactive' || last.kind === 'briefing') return false;
  return now.getTime() - new Date(last.createdAt).getTime() < CONVERSATION_IDLE_MS;
}

/** Template de cobrança (sem IA) — curto, direto, com a reflexão característica do Lärk. */
export function checkinTemplate(commitment: Commitment, settings: Settings, now: Date): string {
  const you = vocative(settings);
  const what = `“${commitment.description}”`;
  const when = commitment.dueAt ? ` O prazo era ${friendlyDateTime(commitment.dueAt, settings.timezone, now)}.` : '';
  if (commitment.checkCount >= MAX_CHECKINS - 1) {
    return (
      `Última vez que eu toco nesse assunto${you}: ${what}.${when} Cumpriu? ` +
      'Se não rolou, sem drama — me diga e eu marco como não cumprida, ou a gente renegocia o prazo. ' +
      'Promessa honesta vale mais que promessa bonita.'
    );
  }
  const reflections = [
    'Palavra dada é a moeda mais valiosa que existe — e quem honra a que dá a si mesmo nunca fica sem crédito.',
    'Disciplina é lembrar do que você quer quando ninguém está olhando. Eu estou olhando — com carinho.',
    'Quem cumpre o pequeno ganha o direito de sonhar grande.',
    'Medo é o ingresso; a ação é o espetáculo.',
  ];
  return `E aí${you}? Você me disse: ${what}.${when} Cumpriu? ${pick(reflections, commitment.id + commitment.checkCount)}`;
}

const CHECKIN_TASK = `Você está cobrando, com elegância, uma promessa que o usuário fez a si mesmo e registrou com você.
Escreva UMA mensagem curta (2 a 3 frases, no máximo 60 palavras), em português do Brasil, que:
- pergunte diretamente se ele cumpriu (cite a promessa com as palavras dele);
- carregue uma reflexão breve e marcante sobre palavra dada, disciplina ou coragem — tom de mentor e amigo, firme e caloroso, nunca moralista, nunca humilhante;
- termine com a pergunta ou com uma frase de impacto em ponto final.
Sem títulos, sem listas, sem emojis em excesso (no máximo um). Não invente fatos além dos dados abaixo.`;

const LAST_CHECKIN_TASK = `${CHECKIN_TASK}
ATENÇÃO: esta é a terceira e última cobrança. Sugira, sem drama, marcar como não cumprida ou renegociar o prazo.`;

export interface CheckinResult {
  commitment: Commitment;
  message: ChatMessage;
}

/**
 * Faz no máximo uma cobrança agora (e marca promessas abandonadas como 'missed').
 * Devolve a cobrança feita, ou null se nada foi cobrado.
 */
export async function runCheckins(now: Date = new Date()): Promise<CheckinResult | null> {
  const settings = getSettings();
  if (!settings.proactive.enabled) return null;
  if (isQuietTime(now, settings)) return null;

  markAbandonedCommitments(now, settings);
  const target = selectCommitmentForCheckin(listCommitments({ status: 'pending' }), now, settings);
  if (!target) return null;

  const conversation = getOrCreateActiveConversation();
  if (conversationIsBusy(conversation.id, now)) return null;

  // Registra a cobrança antes de gerar o texto: um ciclo lento nunca cobra duas vezes.
  const checked = updateCommitment(target.id, { lastCheckedAt: now.toISOString(), checkCount: target.checkCount + 1 });
  if (!checked) return null;

  const isLast = target.checkCount >= MAX_CHECKINS - 1;
  const prompt = [
    `Promessa: "${target.description}"`,
    target.dueAt ? `Prazo: ${friendlyDateTime(target.dueAt, settings.timezone, now)}` : 'Prazo: não definido',
    `Feita em: ${friendlyDateTime(target.createdAt, settings.timezone, now)}`,
    `Cobranças anteriores: ${target.checkCount}`,
    target.notes ? `Notas: ${target.notes}` : null,
    `Agora: ${friendlyDateTime(now.toISOString(), settings.timezone, now)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const content = await composeWithLark({
    task: isLast ? LAST_CHECKIN_TASK : CHECKIN_TASK,
    prompt,
    fallback: checkinTemplate(target, settings, now),
    maxWords: 60,
    settings,
  });

  const message = addMessage({ conversationId: conversation.id, role: 'assistant', content, kind: 'proactive' });
  bus.publish({ type: 'checkin', commitment: checked, message });
  return { commitment: checked, message };
}
