/**
 * POST /api/chat (SSE de ChatStreamEvent), POST /api/chat/stop e POST /api/briefing.
 */
import type { ChatMessage, ChatStreamEvent, ToolCallInfo } from '@shared/types';
import { EngineError, NO_ENGINE_MESSAGE, plannedModel, resolveEngine, runTurn } from './brain';
import {
  addMessage,
  countMessages,
  getConversation,
  getOrCreateActiveConversation,
  getSettings,
  listCommitments,
  listMessages,
  listReminders,
} from './db';
import { sseResponse } from './sse';
import { formatRelative, localHourMinute, safeTimeZone } from './time';
import { HttpError, badRequest, isAbort, isRecord, newId, nowIso, truncate } from './util';

const running = new Map<string, AbortController>();

export function stopChat(conversationId: string): boolean {
  const ctl = running.get(conversationId);
  if (!ctl) return false;
  ctl.abort();
  running.delete(conversationId);
  return true;
}

export function chatRoute(body: unknown, signal: AbortSignal | undefined): Response {
  if (!isRecord(body)) throw badRequest('Corpo inválido: envie {conversationId?, message}.');
  const text = typeof body.message === 'string' ? body.message.trim() : '';
  if (!text) throw badRequest('Escreva uma mensagem.');
  if (text.length > 20_000) throw new HttpError(413, 'A mensagem é grande demais para ser enviada de uma vez.');
  const requestedId = typeof body.conversationId === 'string' ? body.conversationId : null;

  const ctl = new AbortController();
  return sseResponse(
    signal,
    async (w) => {
      const send = (ev: ChatStreamEvent) => w.send(ev);

      const engine = await resolveEngine();
      if (ctl.signal.aborted) return;
      if (!engine) {
        send({ type: 'error', code: 'no_api_key', message: NO_ENGINE_MESSAGE });
        w.close();
        return;
      }

      const conv = (requestedId && getConversation(requestedId)) || getOrCreateActiveConversation();
      running.get(conv.id)?.abort();
      running.set(conv.id, ctl);

      const history = listMessages(conv.id, { limit: 40 });
      const userMsg = addMessage({ conversationId: conv.id, role: 'user', content: text, kind: 'chat' });
      const assistantId = newId();
      send({ type: 'meta', conversationId: conv.id, userMessageId: userMsg.id, assistantMessageId: assistantId, model: plannedModel() });

      let content = '';
      let thoughts = '';
      const tools: ToolCallInfo[] = [];
      const save = (finalContent: string, finalThoughts: string, finalTools: ToolCallInfo[]): ChatMessage =>
        addMessage({
          id: assistantId,
          conversationId: conv.id,
          role: 'assistant',
          content: finalContent,
          thoughts: finalThoughts || null,
          toolCalls: finalTools,
          kind: 'chat',
          createdAt: new Date(Math.max(Date.now(), Date.parse(userMsg.createdAt) + 1)).toISOString(),
        });

      try {
        const out = await runTurn({
          conversationId: conv.id,
          userText: text,
          history,
          settings: getSettings(),
          signal: ctl.signal,
          onThought: (t) => {
            thoughts += t;
            send({ type: 'thought', text: t });
          },
          onToken: (t) => {
            content += t;
            send({ type: 'token', text: t });
          },
          onTool: (call) => {
            const i = tools.findIndex((c) => c.id === call.id);
            if (i >= 0) tools[i] = call;
            else tools.push(call);
            send({ type: 'tool', call });
          },
        });
        if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError');
        const message = save(out.content, out.thoughts, out.toolCalls.length ? out.toolCalls : tools);
        send({ type: 'done', message });
      } catch (e) {
        if (isAbort(e) || ctl.signal.aborted) {
          // Interrompido: guarda o que já tinha sido dito.
          if (content.trim() || tools.length) save(content.trim(), thoughts, tools);
          return;
        }
        const err = e instanceof EngineError ? e : new EngineError('internal', 'Algo falhou no núcleo do Lärk ao processar sua mensagem.');
        if (!(e instanceof EngineError)) console.error('[Lärk web] Falha no turno:', e);
        const partial = (err.partial || content).trim();
        if (partial || tools.length) save(partial, thoughts, tools);
        send({ type: 'error', code: err.code, message: err.message });
      } finally {
        if (running.get(conv.id) === ctl) running.delete(conv.id);
        w.close();
      }
    },
    () => ctl.abort(),
  );
}

// ─── Briefing (local, sem gastar IA) ─────────────────────────────────────

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function greetingFor(hour: number): string {
  if (hour < 5) return 'Boa madrugada';
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

const CLOSERS = [
  'Quando eu falo oi, já venci. Bora?',
  'O dia não pergunta se você está pronto. Ele começa. Bora?',
  'Medo é o ingresso. O show é seu.',
  'Pequenas promessas cumpridas constroem grandes reputações — principalmente com você mesmo.',
  'Disciplina é lembrar do que você quer quando o Freio sugere o contrário.',
];

/** Mensagem de briefing; null no primeiro contato (a interface mostra a abertura com sugestões). */
export function briefingRoute(body: unknown): { message: ChatMessage | null } {
  const b = isRecord(body) ? body : {};
  const force = b.force === true;
  if (!force && countMessages() === 0) return { message: null };
  const conv = (typeof b.conversationId === 'string' && getConversation(b.conversationId)) || getOrCreateActiveConversation();

  const settings = getSettings();
  const tz = safeTimeZone(settings.timezone);
  const now = new Date();
  const { hour } = localHourMinute(now, tz);
  const name = settings.userName.trim();
  const dateLine = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(now);

  const lines: string[] = [];
  lines.push(`${greetingFor(hour)}${name ? `, ${name}` : ''}. ${dateLine.charAt(0).toUpperCase()}${dateLine.slice(1)}.`);

  const open = listCommitments({ status: 'open' });
  const overdue = open.filter((c) => c.dueAt && Date.parse(c.dueAt) < now.getTime());
  const endOfDay = now.getTime() + 24 * 3600_000;
  const upcoming = listReminders({ status: 'scheduled' }).filter((r) => Date.parse(r.dueAt) <= endOfDay);

  const agenda: string[] = [];
  if (open.length) {
    agenda.push(
      `${open.length} ${open.length === 1 ? 'promessa em aberto' : 'promessas em aberto'}${overdue.length ? ` — ${overdue.length} já ${overdue.length === 1 ? 'passou' : 'passaram'} do prazo` : ''}`,
    );
  }
  if (upcoming.length) {
    const next = upcoming[0];
    agenda.push(`próximo lembrete ${formatRelative(next.dueAt, tz, now)}: **${truncate(next.text, 80)}**`);
  }
  if (agenda.length) lines.push('', `Na mesa: ${agenda.join('; ')}.`);
  else lines.push('', 'Agenda limpa. Espaço em branco é convite — escolha uma coisa que mereça o seu melhor e me diga.');
  if (overdue.length) lines.push('', `O Freio adora prazos vencidos. Vamos tirar **${truncate(overdue[0].description, 80)}** da frente?`);
  if (!name) lines.push('', 'Aliás: como você prefere ser chamado? Eu guardo.');
  lines.push('', pick(CLOSERS));

  const message = addMessage({ conversationId: conv.id, role: 'assistant', content: lines.join('\n'), kind: 'briefing', createdAt: nowIso() });
  return { message };
}
