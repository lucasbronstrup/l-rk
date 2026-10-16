/**
 * Trabalho de bastidores depois de cada turno: extração de memórias/promessas e resumo da conversa.
 *
 * `schedulePostTurn()` agenda o processamento com debounce (~2 s) numa fila por conversa: nunca
 * roda duas vezes ao mesmo tempo para a mesma conversa; pedidos que chegam durante uma execução
 * geram uma nova rodada logo depois. Em modo demonstração ou sem chave, nada é feito.
 */
import { config } from '../config.js';
import { classifyGeminiError, getClient } from '../llm/gemini.js';
import { getConversation } from '../memory/conversations.js';
import { extractFromLastExchange } from './extract.js';
import { maybeSummarize } from './summarize.js';

const DEBOUNCE_MS = 2_000;

const timers = new Map<string, NodeJS.Timeout>();
const running = new Map<string, Promise<void>>();
const rerun = new Set<string>();

function enabled(): boolean {
  if (config.mock || process.env.LARK_MOCK === '1') return false;
  try {
    return getClient() !== null;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  const { code, message } = classifyGeminiError(error);
  return `${code}: ${message}`;
}

async function processConversation(conversationId: string): Promise<void> {
  if (!enabled() || !getConversation(conversationId)) return;
  try {
    const result = await extractFromLastExchange(conversationId);
    if (result && (result.memoriesCreated || result.memoriesUpdated || result.commitmentsCreated || result.commitmentsUpdated)) {
      console.log(
        `[pós-turno] memórias +${result.memoriesCreated}/~${result.memoriesUpdated} · promessas +${result.commitmentsCreated}/~${result.commitmentsUpdated}`,
      );
    }
  } catch (error) {
    console.warn('[pós-turno] extração falhou —', describe(error));
  }
  try {
    if (await maybeSummarize(conversationId)) console.log('[pós-turno] resumo da conversa atualizado');
  } catch (error) {
    console.warn('[pós-turno] resumo falhou —', describe(error));
  }
}

function start(conversationId: string): void {
  if (running.has(conversationId)) {
    rerun.add(conversationId);
    return;
  }
  const task = processConversation(conversationId)
    .catch((error: unknown) => console.warn('[pós-turno] erro inesperado:', error))
    .finally(() => {
      running.delete(conversationId);
      if (rerun.delete(conversationId)) schedulePostTurn(conversationId);
    });
  running.set(conversationId, task);
}

/** Agenda extração de memórias/promessas e resumo da conversa, em segundo plano. */
export function schedulePostTurn(conversationId: string): void {
  if (!conversationId) return;
  const existing = timers.get(conversationId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(conversationId);
    start(conversationId);
  }, DEBOUNCE_MS);
  timer.unref?.();
  timers.set(conversationId, timer);
}

/** Executa já o que estiver agendado e espera tudo terminar (testes e encerramento gracioso). */
export async function flushPostTurn(): Promise<void> {
  for (const [conversationId, timer] of [...timers]) {
    clearTimeout(timer);
    timers.delete(conversationId);
    start(conversationId);
  }
  while (running.size > 0 || timers.size > 0) {
    await Promise.all([...running.values()]);
    for (const [conversationId, timer] of [...timers]) {
      clearTimeout(timer);
      timers.delete(conversationId);
      start(conversationId);
    }
  }
}

/** Cancela o que ainda não começou (encerramento do servidor). */
export function cancelPostTurn(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  rerun.clear();
}
