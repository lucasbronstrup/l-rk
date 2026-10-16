/**
 * Loop do agente: um turno completo de conversa com o Lärk.
 *
 * 1. Salva a mensagem do usuário e emite `meta` (ids das mensagens e modelo).
 * 2. Monta o contexto (persona + memória + promessas + lembretes + resumo) e o histórico recente.
 * 3. Chama `generateContentStream` com ferramentas e pensamento visível; troca de modelo em
 *    cota/404/5xx ANTES do primeiro pedaço da resposta.
 * 4. Emite `thought`/`token` enquanto o modelo fala; executa as ferramentas pedidas (em paralelo quando
 *    não exigem aprovação), devolve os resultados ao modelo preservando as `thoughtSignature`s e repete
 *    (máx. 8 rodadas).
 * 5. Salva a resposta (texto, raciocínio e ferramentas), emite `done` e agenda o pós-turno
 *    (extração de memórias/promessas e resumo).
 *
 * Erros viram evento `error` (mensagem amigável em PT-BR) e a promessa rejeita com `AgentTurnError`.
 * Cancelamento (`signal`): o que já foi gerado é salvo e devolvido; sem nada gerado, rejeita com AbortError.
 */
import {
  FunctionCallingConfigMode,
  type Content,
  type FunctionCall,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type GoogleGenAI,
  type Part,
} from '@google/genai';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import {
  GeminiError,
  classifyGeminiError,
  cooldownModel,
  getClient,
  getModelFallbacks,
  isRetryableModelError,
  parseGeminiError,
  reportModelFailure,
  resolveModel,
} from '../llm/gemini.js';
import { getConversation } from '../memory/conversations.js';
import { addMessage, listMessages } from '../memory/messages.js';
import { getSettings } from '../memory/settings.js';
import { effectiveRisk, getTool, getToolDeclarations, needsApproval, runTool } from '../tools/index.js';
import type { ToolResult } from '../tools/types.js';
import { HISTORY_WINDOW, buildSystemInstruction, toGeminiHistory } from './context.js';
import { MOCK_MODEL, runMockTurn } from './mock.js';
import { schedulePostTurn } from './post-turn.js';
import type { ChatMessage, ChatStreamEvent, MessageKind, ToolCallInfo } from '../../shared/types.js';

/** Rodadas máximas de "modelo → ferramentas → modelo" por turno. */
export const MAX_TOOL_ITERATIONS = 8;
/** Quantos modelos tentar (o escolhido + reservas) antes de desistir. */
const MAX_MODEL_ATTEMPTS = 4;
/**
 * Sem nenhum pedaço da resposta por este tempo, a tentativa é abandonada. Com pensamento visível o
 * primeiro pedaço chega em poucos segundos; um modelo sobrecarregado às vezes fica mudo em vez de
 * devolver 503, então as tentativas com reserva desistem antes (a última espera mais).
 */
const FIRST_CHUNK_TIMEOUT_MS = 40_000;
const LAST_ATTEMPT_FIRST_CHUNK_TIMEOUT_MS = 90_000;
const IDLE_CHUNK_TIMEOUT_MS = 90_000;
/** Modelo que ficou mudo além do limite fica em espera por este tempo. */
const SILENT_MODEL_COOLDOWN_MS = 5 * 60_000;
/** LARK_DEBUG=1 registra os tempos de cada etapa do turno no console. */
const DEBUG = process.env.LARK_DEBUG === '1';
const debugLog = (message: string) => {
  if (DEBUG) console.log(`[agente] ${message}`);
};
/** Assinatura aceita pelo Gemini quando a original não pode ser reaproveitada (troca de modelo no meio do turno). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const MAX_USER_TEXT = 32_000;

const NO_KEY_MESSAGE =
  'Ainda não tenho uma chave do Google AI Studio. Abra as Configurações, cole a sua chave gratuita do Gemini (aistudio.google.com) e eu ganho pensamento e voz.';

type ErrorCode = 'no_api_key' | 'quota' | 'provider' | 'internal';

/** Falha do turno. O evento `error` correspondente já foi emitido quando a promessa rejeita com ela. */
export class AgentTurnError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentTurnError';
    this.code = code;
  }
}

export interface AgentTurnOptions {
  conversationId: string;
  userText: string;
  kind?: MessageKind;
  onEvent: (e: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

/** Estado acumulado do turno (o que será salvo na mensagem do assistente). */
interface TurnState {
  content: string;
  thoughts: string;
  toolCalls: Map<string, ToolCallInfo>;
}

// ─── Utilidades ──────────────────────────────────────────────────────────

function abortReason(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('Geração interrompida.', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'AbortError';
}

/** Separador de parágrafo necessário para continuar `text` (nada, "\n" ou "\n\n"). */
function paragraphBreak(text: string): string {
  if (/\n\s*\n\s*$/.test(text)) return '';
  return /\n\s*$/.test(text) ? '\n' : '\n\n';
}

/** Modelos de geração 3+ funcionam melhor com a temperatura padrão (1.0). */
function temperatureFor(model: string): number {
  const major = Number(/gemini-(\d+)/.exec(model)?.[1] ?? 0);
  return major >= 3 ? 1.0 : 0.9;
}

/** Modelos que recusaram `thinkingConfig` (descoberto em tempo de execução). */
const noThinkingModels = new Set<string>();

function isThinkingUnsupported(e: unknown): boolean {
  const p = parseGeminiError(e);
  return p.status === 400 && /thinking|thought/i.test(p.message);
}

/** Pergunta de busca na memória: a mensagem do usuário, com o fim da última fala do Lärk se ela for curta. */
function memoryQuery(userText: string, history: ChatMessage[]): string {
  if (userText.length >= 40) return userText;
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  return lastAssistant ? `${userText}\n${lastAssistant.content.trim().slice(-300)}` : userText;
}

/** Temporizador de inatividade do streaming (aborta a requisição se o Gemini ficar mudo). */
function createIdleGuard(initialMs: number, idleMs: number) {
  const controller = new AbortController();
  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      controller.abort(new GeminiError('provider', 'O Gemini parou de responder no meio do caminho. Tente de novo em instantes.'));
    }, ms);
    timer.unref?.();
  };
  arm(initialMs);
  return {
    signal: controller.signal,
    get fired() {
      return fired;
    },
    touch: () => arm(idleMs),
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
type IdleGuard = ReturnType<typeof createIdleGuard>;

/**
 * Remove as assinaturas de pensamento das falas do modelo neste turno (a partir de `from`).
 * Necessário ao trocar de modelo no meio do turno: a assinatura só vale para o modelo que a gerou.
 */
function neutralizeSignatures(contents: Content[], from: number): void {
  for (let i = from; i < contents.length; i++) {
    const c = contents[i];
    if (c.role !== 'model' || !c.parts) continue;
    c.parts = c.parts
      .filter((p) => !p.thought)
      .map((p) => {
        if (p.functionCall) return { ...p, thoughtSignature: SKIP_SIGNATURE };
        if (p.thoughtSignature === undefined) return p;
        const { thoughtSignature: _drop, ...rest } = p;
        return rest;
      })
      .filter((p) => Object.keys(p).length > 0 && !(p.text === '' && Object.keys(p).length === 1));
  }
}

// ─── Streaming com troca de modelo ───────────────────────────────────────

interface OpenedStream {
  model: string;
  iterator: AsyncIterator<GenerateContentResponse>;
  first: IteratorResult<GenerateContentResponse>;
  idle: IdleGuard;
}

/**
 * Abre o streaming no primeiro modelo que responder. Erros de cota/404/5xx (e silêncio prolongado)
 * antes do primeiro pedaço fazem tentar o próximo modelo da lista.
 */
async function openStream(
  ai: GoogleGenAI,
  models: string[],
  contents: Content[],
  baseConfig: GenerateContentConfig,
  signal: AbortSignal | undefined,
  beforeAttempt?: (model: string) => void,
): Promise<OpenedStream> {
  let lastError: unknown = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    beforeAttempt?.(model);
    const isLast = i === models.length - 1;
    const idle = createIdleGuard(isLast ? LAST_ATTEMPT_FIRST_CHUNK_TIMEOUT_MS : FIRST_CHUNK_TIMEOUT_MS, IDLE_CHUNK_TIMEOUT_MS);
    const started = Date.now();
    const abortSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    const modelConfig: GenerateContentConfig = {
      ...baseConfig,
      temperature: temperatureFor(model),
      ...(noThinkingModels.has(model) ? {} : { thinkingConfig: { includeThoughts: true } }),
      abortSignal,
    };
    try {
      const stream = await ai.models.generateContentStream({ model, contents, config: modelConfig });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      debugLog(`${model}: primeiro pedaço em ${Date.now() - started} ms`);
      return { model, iterator, first, idle };
    } catch (error) {
      idle.clear();
      if (signal?.aborted) throw abortReason(signal);
      if (idle.fired) {
        lastError = idle.signal.reason;
        cooldownModel(model, SILENT_MODEL_COOLDOWN_MS);
        console.warn(`[agente] ${model} ficou sem responder por ${Math.round((Date.now() - started) / 1000)} s; tentando o próximo modelo.`);
        continue;
      }
      if (!noThinkingModels.has(model) && isThinkingUnsupported(error)) {
        // O modelo não aceita pensamento visível: tenta de novo o mesmo modelo sem ele.
        noThinkingModels.add(model);
        i--;
        continue;
      }
      if (!isRetryableModelError(error)) throw error;
      reportModelFailure(model, error);
      lastError = error;
      console.warn(`[agente] ${model} indisponível (${parseGeminiError(error).status ?? 'erro'}); tentando o próximo modelo.`);
    }
  }
  throw lastError ?? new GeminiError('provider', 'Nenhum modelo do Gemini respondeu agora. Tente de novo em instantes.');
}

/** Resultado de uma rodada de streaming. */
interface RoundResult {
  model: string;
  /** Partes do modelo como recebidas (texto agrupado), com assinaturas preservadas. */
  parts: Part[];
  calls: FunctionCall[];
  text: string;
  finishReason: string | null;
  blockReason: string | null;
}

/** Parte de texto comum (sem pensamento, assinatura ou outros campos). */
function isPlainText(p: Part): boolean {
  return typeof p.text === 'string' && !p.thought && Object.keys(p).every((k) => k === 'text' || k === 'thought');
}

/** Acrescenta uma parte ao Content do modelo, juntando textos vizinhos sem assinatura. */
function appendPart(parts: Part[], part: Part): void {
  const last = parts[parts.length - 1];
  if (last && isPlainText(last) && isPlainText(part)) {
    last.text = (last.text ?? '') + (part.text ?? '');
    return;
  }
  parts.push({ ...part });
}

async function streamRound(
  opened: OpenedStream,
  handlers: { onThought: (t: string) => void; onText: (t: string) => void },
): Promise<RoundResult> {
  const { iterator, idle } = opened;
  const parts: Part[] = [];
  const calls: FunctionCall[] = [];
  let text = '';
  let finishReason: string | null = null;
  let blockReason: string | null = null;
  try {
    for (let r = opened.first; !r.done; r = await iterator.next()) {
      idle.touch();
      const chunk = r.value;
      if (chunk.promptFeedback?.blockReason) blockReason = String(chunk.promptFeedback.blockReason);
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall) {
          calls.push(part.functionCall);
          parts.push({ ...part });
        } else if (part.thought) {
          if (part.text) handlers.onThought(part.text);
          // Resumos de pensamento só voltam ao modelo se carregarem assinatura.
          if (part.thoughtSignature) parts.push({ ...part });
        } else if (typeof part.text === 'string') {
          if (part.text) {
            text += part.text;
            handlers.onText(part.text);
          }
          if (part.text || part.thoughtSignature) appendPart(parts, part);
        } else if (Object.keys(part).length > 0) {
          parts.push({ ...part });
        }
      }
      if (candidate?.finishReason) finishReason = String(candidate.finishReason);
    }
  } catch (error) {
    if (idle.fired) throw idle.signal.reason;
    throw error;
  } finally {
    idle.clear();
  }
  return { model: opened.model, parts, calls, text, finishReason, blockReason };
}

const BLOCKED_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);
const MALFORMED_REASONS = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL']);

// ─── Execução das ferramentas ────────────────────────────────────────────

interface ToolRunContext {
  conversationId: string;
  mode: 'text' | 'voice';
  state: TurnState;
  emit: (e: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

function requiresApproval(call: FunctionCall, approvalMode: ReturnType<typeof getSettings>['computer']['approvalMode']): boolean {
  const def = call.name ? getTool(call.name) : undefined;
  if (!def) return false;
  return needsApproval(effectiveRisk(def, call.args ?? {}), approvalMode);
}

/**
 * Executa as chamadas pedidas pelo modelo. Sequências de chamadas que não precisam de aprovação
 * rodam em paralelo; as que precisam rodam uma de cada vez, na ordem pedida.
 * Devolve as partes de resposta (functionResponse + imagens inline) na ordem das chamadas.
 */
async function executeCalls(calls: FunctionCall[], ctx: ToolRunContext): Promise<Part[]> {
  let approvalMode: ReturnType<typeof getSettings>['computer']['approvalMode'] = 'ask';
  try {
    approvalMode = getSettings().computer.approvalMode;
  } catch {
    // Configurações indisponíveis: assume o modo mais cauteloso.
  }
  const results: { call: FunctionCall; result: ToolResult }[] = new Array(calls.length);

  const runOne = async (index: number) => {
    const call = calls[index];
    const name = call.name ?? '';
    const { call: info, result } = await runTool(
      name,
      call.args ?? {},
      {
        conversationId: ctx.conversationId,
        mode: ctx.mode,
        signal: ctx.signal,
        emit: (update) => {
          ctx.state.toolCalls.set(update.id, update);
          ctx.emit({ type: 'tool', call: update });
        },
      },
      call.id || newId(),
    );
    ctx.state.toolCalls.set(info.id, info);
    results[index] = { call, result };
  };

  let i = 0;
  while (i < calls.length) {
    if (requiresApproval(calls[i], approvalMode)) {
      await runOne(i);
      i++;
      continue;
    }
    let j = i;
    while (j < calls.length && !requiresApproval(calls[j], approvalMode)) j++;
    const batch: Promise<void>[] = [];
    for (let k = i; k < j; k++) batch.push(runOne(k));
    await Promise.all(batch);
    i = j;
  }

  const responseParts: Part[] = [];
  const inlineParts: Part[] = [];
  for (const { call, result } of results) {
    responseParts.push({
      functionResponse: {
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        response: result.output,
      },
    });
    for (const blob of result.inlineData ?? []) {
      if (blob?.data && blob.mimeType) inlineParts.push({ inlineData: { mimeType: blob.mimeType, data: blob.data } });
    }
  }
  return [...responseParts, ...inlineParts];
}

// ─── Turno com o Gemini ──────────────────────────────────────────────────

interface GeminiTurnContext {
  ai: GoogleGenAI;
  conversationId: string;
  mode: 'text' | 'voice';
  userText: string;
  model: string;
  state: TurnState;
  emit: (e: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

async function runGeminiTurn(ctx: GeminiTurnContext): Promise<void> {
  const { ai, state, emit, signal } = ctx;
  const history = listMessages(ctx.conversationId, { limit: HISTORY_WINDOW });
  const contents = toGeminiHistory(history);
  const contextStarted = Date.now();
  const systemInstruction = await buildSystemInstruction({
    conversationId: ctx.conversationId,
    mode: ctx.mode,
    query: memoryQuery(ctx.userText, history),
  });
  debugLog(`contexto montado em ${Date.now() - contextStarted} ms (${systemInstruction.length} caracteres)`);
  if (signal?.aborted) throw abortReason(signal);

  const declarations = getToolDeclarations(ctx.mode);
  const turnStart = contents.length;
  let committedModel: string | null = null;
  let malformedRetries = 0;
  let roundsWithText = 0;

  // Entre rodadas (depois de ferramentas), separa o novo trecho do anterior por um parágrafo.
  let pendingTextBreak = false;
  let pendingThoughtBreak = false;
  const onThought = (t: string) => {
    let piece = t;
    if (pendingThoughtBreak) {
      pendingThoughtBreak = false;
      if (state.thoughts.trim()) piece = `${paragraphBreak(state.thoughts)}${t.replace(/^\s+/, '')}`;
    }
    state.thoughts += piece;
    emit({ type: 'thought', text: piece });
  };
  const onText = (t: string) => {
    let piece = t;
    if (pendingTextBreak) {
      pendingTextBreak = false;
      if (state.content.trim()) piece = `${paragraphBreak(state.content)}${t.replace(/^\s+/, '')}`;
    }
    state.content += piece;
    emit({ type: 'token', text: piece });
  };

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const lastRound = iteration === MAX_TOOL_ITERATIONS - 1;
    const baseConfig: GenerateContentConfig = {
      systemInstruction,
      ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
      ...(lastRound && declarations.length > 0
        ? { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } }
        : {}),
    };

    const first = committedModel ?? ctx.model;
    const models = [first, ...getModelFallbacks('chat').filter((m) => m !== first)].slice(0, MAX_MODEL_ATTEMPTS);
    let neutralized = false;
    const opened = await openStream(ai, models, contents, baseConfig, signal, (model) => {
      if (committedModel && model !== committedModel && !neutralized) {
        // Trocando de modelo no meio do turno: as assinaturas antigas só valem para o modelo que as gerou.
        neutralizeSignatures(contents, turnStart);
        neutralized = true;
      }
    });
    committedModel = opened.model;

    pendingTextBreak = iteration > 0;
    pendingThoughtBreak = iteration > 0;
    const roundStarted = Date.now();
    const round = await streamRound(opened, { onThought, onText });
    debugLog(
      `rodada ${iteration + 1} (${opened.model}): ${Date.now() - roundStarted} ms, ${round.text.length} caracteres, ` +
        `ferramentas: ${round.calls.map((c) => c.name).join(', ') || 'nenhuma'}, fim: ${round.finishReason ?? '?'}`,
    );
    if (round.text.trim()) roundsWithText++;

    if (round.calls.length === 0) {
      const empty = !round.text.trim();
      if (empty && MALFORMED_REASONS.has(round.finishReason ?? '') && malformedRetries < 1 && !lastRound) {
        malformedRetries++;
        continue;
      }
      if (empty && (round.blockReason || BLOCKED_REASONS.has(round.finishReason ?? ''))) {
        throw new GeminiError(
          'provider',
          `O Gemini bloqueou esta resposta pelos filtros de segurança (${round.blockReason ?? round.finishReason}). Tente reformular o pedido.`,
        );
      }
      if (empty && roundsWithText === 0 && state.toolCalls.size === 0) {
        throw new GeminiError(
          'provider',
          `O Gemini não devolveu nenhuma resposta${round.finishReason ? ` (${round.finishReason})` : ''}. Tente de novo em instantes.`,
        );
      }
      return;
    }

    if (lastRound) return; // Limite de rodadas: encerra com o que já foi dito.

    contents.push({ role: 'model', parts: round.parts });
    const responseParts = await executeCalls(round.calls, {
      conversationId: ctx.conversationId,
      mode: ctx.mode,
      state,
      emit,
      signal,
    });
    if (signal?.aborted) throw abortReason(signal);
    contents.push({ role: 'user', parts: responseParts });
  }
}

// ─── API pública ─────────────────────────────────────────────────────────

/**
 * Executa um turno completo de conversa e devolve a mensagem do assistente salva.
 * @throws AgentTurnError (depois de emitir `error`) em falhas; AbortError quando cancelado sem
 *         nada gerado.
 */
export async function runAgentTurn(opts: {
  conversationId: string;
  userText: string;
  kind?: MessageKind;
  onEvent: (e: ChatStreamEvent) => void;
  signal?: AbortSignal;
}): Promise<ChatMessage> {
  const emit = (e: ChatStreamEvent) => {
    try {
      opts.onEvent(e);
    } catch (error) {
      console.warn('[agente] falha ao entregar evento:', error instanceof Error ? error.message : error);
    }
  };
  const fail = (code: ErrorCode, message: string, cause?: unknown): never => {
    emit({ type: 'error', code, message });
    throw new AgentTurnError(code, message, cause === undefined ? undefined : { cause });
  };

  const { conversationId, signal } = opts;
  const kind: MessageKind = opts.kind ?? 'chat';
  const mode: 'text' | 'voice' = kind === 'voice' ? 'voice' : 'text';
  const userText = String(opts.userText ?? '').trim().slice(0, MAX_USER_TEXT);

  if (!userText) return fail('internal', 'A mensagem está vazia.');
  if (!getConversation(conversationId)) return fail('internal', 'Conversa não encontrada. Ela pode ter sido apagada.');
  if (signal?.aborted) throw abortReason(signal);

  const userMessage = addMessage({ conversationId, role: 'user', content: userText, kind });
  const assistantMessageId = newId();

  let ai: GoogleGenAI | null = null;
  try {
    ai = getClient();
  } catch (error) {
    console.warn('[agente] cliente do Gemini indisponível:', error instanceof Error ? error.message : error);
  }
  const mock = config.mock || (!ai && process.env.LARK_MOCK === '1');

  if (!ai && !mock) {
    emit({ type: 'meta', conversationId, userMessageId: userMessage.id, assistantMessageId, model: '' });
    return fail('no_api_key', NO_KEY_MESSAGE);
  }

  let model = MOCK_MODEL;
  if (!mock) {
    try {
      model = await resolveModel('chat');
    } catch (error) {
      emit({ type: 'meta', conversationId, userMessageId: userMessage.id, assistantMessageId, model: '' });
      const { code, message } = classifyGeminiError(error);
      return fail(code, message, error);
    }
  }
  emit({ type: 'meta', conversationId, userMessageId: userMessage.id, assistantMessageId, model });

  const state: TurnState = { content: '', thoughts: '', toolCalls: new Map() };
  const save = (): ChatMessage =>
    addMessage({
      id: assistantMessageId,
      conversationId,
      role: 'assistant',
      content: state.content.trimEnd(),
      thoughts: state.thoughts.trim() || null,
      toolCalls: [...state.toolCalls.values()],
      kind: mode === 'voice' ? 'voice' : 'chat',
    });
  const hasOutput = () => state.content.trim().length > 0 || state.toolCalls.size > 0;

  try {
    if (mock) {
      await runMockTurn({
        conversationId,
        userText,
        mode,
        signal,
        onThought: (t) => {
          state.thoughts += t;
          emit({ type: 'thought', text: t });
        },
        onToken: (t) => {
          state.content += t;
          emit({ type: 'token', text: t });
        },
        onTool: (call) => {
          state.toolCalls.set(call.id, call);
          emit({ type: 'tool', call });
        },
      });
    } else {
      await runGeminiTurn({ ai: ai!, conversationId, mode, userText, model, state, emit, signal });
    }
    if (signal?.aborted) throw abortReason(signal);
  } catch (error) {
    if (signal?.aborted) {
      if (!hasOutput()) throw abortReason(signal);
      const partial = save();
      emit({ type: 'done', message: partial });
      schedulePostTurn(conversationId);
      return partial;
    }
    const { code, message } = error instanceof AgentTurnError ? error : classifyGeminiError(error);
    if (code === 'internal') console.error('[agente] erro no turno:', error);
    if (hasOutput()) {
      // Mantém o que já foi dito e feito (ex.: ferramentas executadas) no histórico.
      try {
        save();
        schedulePostTurn(conversationId);
      } catch (saveError) {
        console.error('[agente] não consegui salvar a resposta parcial:', saveError);
      }
    }
    return fail(code, message, error);
  }

  let message: ChatMessage;
  try {
    message = save();
  } catch (error) {
    console.error('[agente] não consegui salvar a resposta:', error);
    return fail('internal', 'Não consegui salvar a resposta no banco de dados.', error);
  }
  emit({ type: 'done', message });
  schedulePostTurn(conversationId);
  return message;
}
