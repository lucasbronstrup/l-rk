/**
 * Rotas do chat em texto.
 *
 * POST /chat {conversationId?, message, kind?} → text/event-stream de `ChatStreamEvent`
 *   (`event: <type>` + `data: <JSON do evento inteiro>`), com comentário de heartbeat a cada 15 s.
 *   Um turno por conversa: um novo turno na mesma conversa interrompe o anterior.
 *   Se o navegador desconectar no meio, a geração continua e a resposta fica salva.
 * POST /chat/stop {conversationId} → {ok, stopped} (interrompe a geração; o que já saiu fica salvo).
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { getConversation, getOrCreateActiveConversation } from '../memory/conversations.js';
import { classifyGeminiError } from '../llm/gemini.js';
import { AgentTurnError, runAgentTurn } from '../agent/loop.js';
import type { ChatStreamEvent } from '../../shared/types.js';

const HEARTBEAT_MS = 15_000;
/** Quanto esperar o turno anterior (interrompido) salvar o que gerou antes de começar o novo. */
const PREVIOUS_TURN_GRACE_MS = 5_000;
const MAX_MESSAGE_CHARS = 32_000;

interface ActiveTurn {
  controller: AbortController;
  /** Resolve quando o turno termina (com sucesso, erro ou cancelamento). */
  finished: Promise<void>;
}

const activeTurns = new Map<string, ActiveTurn>();

const chatBodySchema = z.object({
  conversationId: z.string().trim().min(1).max(200).nullish(),
  message: z
    .string({ error: 'Envie o texto da mensagem.' })
    .trim()
    .min(1, 'A mensagem está vazia.')
    .max(MAX_MESSAGE_CHARS, `A mensagem é longa demais (máximo de ${MAX_MESSAGE_CHARS.toLocaleString('pt-BR')} caracteres).`),
  kind: z.enum(['chat', 'voice']).optional(),
});

const stopBodySchema = z.object({
  conversationId: z.string({ error: 'Informe a conversa.' }).trim().min(1, 'Informe a conversa.'),
});

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Requisição inválida.';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Interrompe o turno em andamento numa conversa. Devolve true se havia um. */
export function abortChatTurn(conversationId: string, reason = 'Geração interrompida pelo usuário.'): boolean {
  const active = activeTurns.get(conversationId);
  if (!active) return false;
  active.controller.abort(new DOMException(reason, 'AbortError'));
  return true;
}

/** true se há uma resposta sendo gerada nesta conversa. */
export function isChatTurnActive(conversationId: string): boolean {
  return activeTurns.has(conversationId);
}

export const chatRoutes = new Hono();

chatRoutes.post('/chat', async (c) => {
  const parsed = chatBodySchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
  const { message, kind } = parsed.data;

  let conversationId: string;
  if (parsed.data.conversationId) {
    const conversation = getConversation(parsed.data.conversationId);
    if (!conversation) return c.json({ error: 'Conversa não encontrada. Ela pode ter sido apagada.' }, 404);
    conversationId = conversation.id;
  } else {
    conversationId = getOrCreateActiveConversation().id;
  }

  // Um turno por conversa: o novo interrompe o anterior e espera ele salvar o que já gerou.
  const previous = activeTurns.get(conversationId);
  const controller = new AbortController();
  let markFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  const turn: ActiveTurn = { controller, finished };
  activeTurns.set(conversationId, turn);
  if (previous) previous.controller.abort(new DOMException('Substituído por uma nova mensagem.', 'AbortError'));

  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    // Escritas em fila: os eventos saem na ordem, sem bloquear o loop do agente.
    let queue: Promise<void> = Promise.resolve();
    const send = (event: ChatStreamEvent) => {
      if (stream.aborted || stream.closed) return;
      const data = JSON.stringify(event);
      queue = queue.then(() => stream.writeSSE({ event: event.type, data })).catch(() => undefined);
    };
    const heartbeat = setInterval(() => {
      if (stream.aborted || stream.closed) return;
      queue = queue.then(() => stream.write(': ping\n\n').then(() => undefined)).catch(() => undefined);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      if (previous) await Promise.race([previous.finished, delay(PREVIOUS_TURN_GRACE_MS)]);
      if (controller.signal.aborted) return;
      await runAgentTurn({ conversationId, userText: message, kind, onEvent: send, signal: controller.signal });
    } catch (error) {
      if (error instanceof AgentTurnError) {
        // O evento `error` já foi enviado pelo loop.
      } else if (controller.signal.aborted) {
        // Cancelado antes de gerar qualquer coisa: o cliente já sabe (foi ele quem parou).
      } else {
        console.error('[chat] falha inesperada no turno:', error);
        const { code, message: text } = classifyGeminiError(error);
        send({ type: 'error', code, message: text });
      }
    } finally {
      clearInterval(heartbeat);
      if (activeTurns.get(conversationId) === turn) activeTurns.delete(conversationId);
      markFinished();
      await queue;
    }
  });
});

chatRoutes.post('/chat/stop', async (c) => {
  const parsed = stopBodySchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
  const stopped = abortChatTurn(parsed.data.conversationId);
  return c.json({ ok: true, stopped });
});
