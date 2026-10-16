/**
 * Cliente do Gemini (Google AI Studio) compartilhado por todo o servidor.
 *
 * - `getClient()` mantém uma instância de `GoogleGenAI` atrelada à chave atual (recria quando muda).
 * - `listAvailableModels()` consulta `models.list` (cache de 1 h) e infere a função de cada modelo.
 * - `resolveModel()` / `getModelFallbacks()` escolhem o melhor modelo gratuito por função, respeitando
 *   escolhas do usuário e pulando modelos que acabaram de estourar a cota (cooldown).
 * - `generateText()` / `generateWithFallback()` fazem chamadas únicas com troca automática de modelo
 *   em 429/404/5xx.
 * - `classifyGeminiError()` traduz erros do SDK em mensagens amigáveis em PT-BR.
 */
import {
  ApiError,
  GoogleGenAI,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Model,
} from '@google/genai';
import { config } from '../config.js';
import { getApiKey, getSettings } from '../memory/settings.js';
import type { ModelInfo, ModelRole } from '../../shared/types.js';

// ─── Erros ───────────────────────────────────────────────────────────────

export type GeminiErrorCode = 'no_api_key' | 'quota' | 'provider' | 'internal';

/** Erro já classificado, com mensagem pronta para o usuário. */
export class GeminiError extends Error {
  readonly code: GeminiErrorCode;
  constructor(code: GeminiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GeminiError';
    this.code = code;
  }
}

const NO_KEY_MESSAGE =
  'Ainda não tenho uma chave do Google AI Studio. Abra as Configurações, cole sua chave gratuita do Gemini e eu ganho voz e pensamento.';

interface ParsedApiError {
  status: number | null;
  /** Status textual do Google (ex.: RESOURCE_EXHAUSTED, INVALID_ARGUMENT). */
  reason: string;
  message: string;
  /** Atraso sugerido pelo servidor (RetryInfo), em ms. */
  retryDelayMs: number | null;
  /** true quando a cota estourada é diária. */
  daily: boolean;
}

/** Extrai status, motivo e detalhes de um erro do SDK (a mensagem do ApiError é o JSON da resposta). */
export function parseGeminiError(e: unknown): ParsedApiError {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  let status: number | null = null;
  if (e instanceof ApiError) status = e.status;
  else if (typeof (e as { status?: unknown } | null)?.status === 'number') status = (e as { status: number }).status;

  let reason = '';
  let message = raw;
  let retryDelayMs: number | null = null;
  let daily = /PerDay/i.test(raw);

  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as {
        error?: { code?: number; message?: string; status?: string; details?: Array<Record<string, unknown>> };
      };
      const err = body.error;
      if (err) {
        if (typeof err.code === 'number' && status === null) status = err.code;
        if (typeof err.status === 'string') reason = err.status;
        if (typeof err.message === 'string') message = err.message;
        for (const d of err.details ?? []) {
          const delay = d.retryDelay;
          if (typeof delay === 'string') {
            const secs = Number.parseFloat(delay);
            if (Number.isFinite(secs)) retryDelayMs = Math.round(secs * 1000);
          }
          if (Array.isArray(d.violations) && d.violations.some((v) => /PerDay/i.test(String(v?.quotaId ?? '')))) {
            daily = true;
          }
        }
      }
    } catch {
      // Mensagem não era JSON: mantém o texto bruto.
    }
  }
  if (!reason) {
    const m = raw.match(/\b(RESOURCE_EXHAUSTED|INVALID_ARGUMENT|PERMISSION_DENIED|UNAUTHENTICATED|NOT_FOUND|UNAVAILABLE|INTERNAL|FAILED_PRECONDITION|DEADLINE_EXCEEDED)\b/);
    if (m) reason = m[1];
  }
  if (status === null && reason === 'RESOURCE_EXHAUSTED') status = 429;
  return { status, reason, message: message.split('\n')[0].slice(0, 400), retryDelayMs, daily };
}

function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function isNetworkError(e: unknown): boolean {
  const text = `${(e as { message?: unknown } | null)?.message ?? ''} ${String((e as { cause?: { code?: unknown } } | null)?.cause?.code ?? '')}`;
  return /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network/i.test(text);
}

function isInvalidKey(p: ParsedApiError): boolean {
  return (
    /API[_ ]?key (not valid|invalid|expired)|API_KEY_INVALID|API key not found|API key expired|invalid api key/i.test(p.message) ||
    p.status === 401 ||
    p.reason === 'UNAUTHENTICATED' ||
    (p.status === 403 && /api key|permission|forbidden|denied/i.test(p.message))
  );
}

/** Traduz qualquer erro do Gemini em um código estável e uma mensagem amigável em PT-BR. */
export function classifyGeminiError(e: unknown): { code: GeminiErrorCode; message: string } {
  if (e instanceof GeminiError) return { code: e.code, message: e.message };
  if (isAbortError(e)) {
    return { code: 'provider', message: 'O Gemini demorou demais para responder. Vamos tentar de novo em instantes.' };
  }
  const p = parseGeminiError(e);
  if (p.status === 429 || p.reason === 'RESOURCE_EXHAUSTED' || /quota|rate limit/i.test(p.message)) {
    return {
      code: 'quota',
      message: p.daily
        ? 'Atingimos o limite diário gratuito do Gemini para este modelo. Ele se renova em até 24 horas — enquanto isso, posso seguir com outro modelo se você escolher nas Configurações.'
        : 'Atingimos o limite gratuito do Gemini por agora. Respire um instante: em cerca de um minuto voltamos a pensar juntos.',
    };
  }
  if (isInvalidKey(p)) {
    return {
      code: 'no_api_key',
      message: 'A chave do Google AI Studio parece inválida, expirada ou sem permissão. Confira-a nas Configurações.',
    };
  }
  if (/location is not supported|not available in your country|region/i.test(p.message)) {
    return { code: 'provider', message: 'O Gemini não está disponível na região de onde esta chave está sendo usada.' };
  }
  if (p.status === 404 || p.reason === 'NOT_FOUND') {
    return {
      code: 'provider',
      message: 'O modelo do Gemini escolhido não está disponível para a sua chave. Deixe a escolha em automático nas Configurações.',
    };
  }
  if (p.status === 400 || p.reason === 'INVALID_ARGUMENT' || p.reason === 'FAILED_PRECONDITION') {
    return { code: 'provider', message: `O Gemini recusou a requisição: ${p.message || 'dados inválidos'}.` };
  }
  if (p.status !== null && p.status >= 500) {
    return {
      code: 'provider',
      message: 'Os servidores do Gemini estão sobrecarregados neste momento. Tente de novo em alguns instantes.',
    };
  }
  if (isNetworkError(e)) {
    return {
      code: 'provider',
      message: 'Não consegui falar com os servidores do Google. Verifique a conexão com a internet.',
    };
  }
  const detail = e instanceof Error ? e.message : String(e);
  return { code: 'internal', message: `Algo deu errado do meu lado: ${detail.split('\n')[0].slice(0, 200)}` };
}

/** true quando vale a pena tentar outro modelo (cota, modelo inexistente, sobrecarga). */
export function isRetryableModelError(e: unknown): boolean {
  if (e instanceof GeminiError || isAbortError(e)) return false;
  const p = parseGeminiError(e);
  if (p.status === 429 || p.reason === 'RESOURCE_EXHAUSTED') return true;
  if (p.status === 404 || p.reason === 'NOT_FOUND') return true;
  if (p.status !== null && p.status >= 500) return true;
  // Alguns modelos rejeitam recursos específicos (ex.: busca, JSON) com 400 "not supported".
  if (p.status === 400 && /not supported|unsupported|is not available|does not support/i.test(p.message)) return true;
  return false;
}

// ─── Cooldown de modelos (cota estourada, indisponíveis) ────────────────

const cooldowns = new Map<string, number>();

/**
 * Registra uma falha de modelo para que a resolução automática o evite por um tempo.
 * Chamado internamente; o loop do agente e a voz também podem usar em erros de streaming.
 */
export function reportModelFailure(model: string, error: unknown): void {
  const p = parseGeminiError(error);
  let ms = 0;
  if (p.status === 429 || p.reason === 'RESOURCE_EXHAUSTED') {
    ms = p.daily ? 60 * 60_000 : Math.min(Math.max(p.retryDelayMs ?? 60_000, 15_000), 10 * 60_000);
  } else if (p.status === 404 || p.reason === 'NOT_FOUND') {
    ms = 6 * 60 * 60_000;
  } else if (p.status !== null && p.status >= 500) {
    ms = 20_000;
  } else if (p.status === 400 && /not supported|unsupported|does not support/i.test(p.message)) {
    ms = 30 * 60_000;
  }
  if (ms > 0) cooldowns.set(stripPrefix(model), Date.now() + ms);
}

/** Põe um modelo em espera por `ms` (ex.: ficou mudo além do limite, sem devolver erro HTTP). */
export function cooldownModel(model: string, ms: number): void {
  if (ms > 0) cooldowns.set(stripPrefix(model), Date.now() + ms);
}

function inCooldown(model: string): boolean {
  const until = cooldowns.get(model);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    cooldowns.delete(model);
    return false;
  }
  return true;
}

/** Limpa os cooldowns (usado em testes e quando a chave muda). */
export function resetModelCooldowns(): void {
  cooldowns.clear();
}

// ─── Cliente ─────────────────────────────────────────────────────────────

let client: GoogleGenAI | null = null;
let clientKey = '';

/** Cliente do Gemini para a chave atual; null quando não há chave configurada. */
export function getClient(): GoogleGenAI | null {
  const key = getApiKey().trim();
  if (!key) {
    client = null;
    clientKey = '';
    return null;
  }
  if (!client || key !== clientKey) {
    client = new GoogleGenAI({ apiKey: key });
    clientKey = key;
    // Outra chave pode ter outro catálogo e outras cotas.
    modelCache = null;
    listFailure = null;
    cooldowns.clear();
  }
  return client;
}

// ─── Catálogo de modelos ─────────────────────────────────────────────────

/** Preferências por função, da melhor para a pior (todas com cota gratuita no AI Studio). */
export const PREFERRED_MODELS: Readonly<Record<ModelRole, readonly string[]>> = Object.freeze({
  // IDs conferidos com models.list (ver "Fatos verificados" no ARCHITECTURE.md). O 3.8 costuma dar 503
  // em horários de pico: o fallback segue para as versões anteriores.
  chat: [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-flash-latest',
    'gemini-2.5-flash',
  ],
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'],
  // Nunca "pro": o TTS pro exige faturamento.
  tts: ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts'],
  live: [
    'gemini-3.8-live',
    'gemini-3.1-flash-live-preview',
    'gemini-2.5-flash-native-audio-latest',
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-3.8-live-extended-thinking',
  ],
  embedding: ['gemini-embedding-2', 'gemini-embedding-001'],
});

const ROLES: ModelRole[] = ['chat', 'fast', 'tts', 'live', 'embedding'];
const MODEL_LIST_TTL_MS = 60 * 60_000;
const MODEL_LIST_FAILURE_TTL_MS = 60_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;

/** Famílias que não servem para conversa em texto. */
const NON_TEXT_PATTERN =
  /image|tts|live|audio|embedding|aqa|imagen|veo|learnlm|robotics|computer-use|gemma|lyria|banana|deep-research|antigravity|transcribe|translate/;

/** Modelos com bidiGenerateContent que não conversam (só transcrevem, traduzem, controlam robôs ou fazem música). */
const NON_CONVERSATIONAL_LIVE_PATTERN = /transcribe|translate|robotics|lyria|music/;

let modelCache: { key: string; at: number; models: ModelInfo[] } | null = null;
let listFailure: { key: string; at: number; error: unknown } | null = null;
let listInflight: Promise<ModelInfo[]> | null = null;

function stripPrefix(name: string): string {
  return name.trim().replace(/^models\//, '');
}

/** Infere as funções de um modelo pelo nome e pelas ações suportadas. */
export function inferModelRoles(id: string, supportedActions: readonly string[] = []): ModelRole[] {
  const name = id.toLowerCase();
  const actions = new Set(supportedActions);
  const roles: ModelRole[] = [];
  const live =
    (actions.has('bidiGenerateContent') || /live|native-audio/.test(name)) && !NON_CONVERSATIONAL_LIVE_PATTERN.test(name);
  const tts = /tts/.test(name);
  const embedding = actions.has('embedContent') || actions.has('batchEmbedContents') || /embedding/.test(name);
  if (live && !tts && !embedding) roles.push('live');
  if (tts) roles.push('tts');
  if (embedding && !tts && !/live|native-audio/.test(name)) roles.push('embedding');
  const generates = actions.size === 0 ? /^gemini/.test(name) : actions.has('generateContent');
  if (generates && /^gemini/.test(name) && !NON_TEXT_PATTERN.test(name)) roles.push('chat', 'fast');
  return roles;
}

function toModelInfo(m: Model): ModelInfo | null {
  if (!m.name) return null;
  const id = stripPrefix(m.name);
  const roles = inferModelRoles(id, m.supportedActions ?? []);
  if (roles.length === 0) return null;
  return { id, displayName: m.displayName?.trim() || id, roles };
}

function versionOf(id: string): number | null {
  const m = id.match(/gemini-(?:live-)?(\d+(?:\.\d+)?)/);
  return m ? Number.parseFloat(m[1]) : null;
}

/** Pontuação heurística para modelos fora da lista de preferência (maior = melhor). */
function heuristicScore(role: ModelRole, id: string, maxVersion: number): number {
  const n = id.toLowerCase();
  const version = versionOf(n) ?? (/latest/.test(n) ? maxVersion - 0.01 : 0);
  let score = version * 100;
  if (/flash/.test(n)) score += 30;
  if (/lite/.test(n)) score += role === 'fast' ? 25 : role === 'chat' ? -20 : 0;
  if (/\bpro\b|-pro/.test(n)) score -= role === 'tts' ? 1000 : 120;
  if (/exp|experimental/.test(n)) score -= 40;
  if (/preview/.test(n)) score -= 4;
  if (/thinking/.test(n)) score -= 10;
  if (/-8b|nano/.test(n)) score -= role === 'fast' ? 0 : 25;
  if (/-\d{2}-\d{4}$|-\d{3}$|-\d{4}-\d{2}-\d{2}$/.test(n)) score -= 3;
  if (role === 'live') score += (/native-audio/.test(n) ? 12 : 0) + (/live/.test(n) ? 6 : 0);
  if (role === 'embedding') score += /gemini-embedding/.test(n) ? 50 : 0;
  return score;
}

/** Ordena candidatos de uma função: preferidos primeiro (na ordem), depois heurística. */
export function rankModelsForRole(role: ModelRole, candidates: readonly string[]): string[] {
  const unique = [...new Set(candidates.map(stripPrefix))];
  let pool = unique;
  if (role === 'tts') {
    const nonPro = unique.filter((id) => !/\bpro\b|-pro/.test(id));
    if (nonPro.length > 0) pool = nonPro;
  }
  const preferred = PREFERRED_MODELS[role].filter((p) => pool.includes(p));
  const rest = pool.filter((id) => !preferred.includes(id));
  const maxVersion = Math.max(0, ...rest.map((id) => versionOf(id) ?? 0));
  rest.sort((a, b) => heuristicScore(role, b, maxVersion) - heuristicScore(role, a, maxVersion) || b.localeCompare(a));
  return [...preferred, ...rest];
}

function mockModels(): ModelInfo[] {
  const map = new Map<string, ModelInfo>();
  for (const role of ROLES) {
    const id = PREFERRED_MODELS[role][0];
    const existing = map.get(id);
    if (existing) existing.roles.push(role);
    else map.set(id, { id, displayName: `${id} (demonstração)`, roles: [role] });
  }
  return [...map.values()];
}

async function fetchModelList(ai: GoogleGenAI, key: string): Promise<ModelInfo[]> {
  const pager = await ai.models.list({
    config: { pageSize: 100, abortSignal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) },
  });
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for await (const m of pager) {
    const info = toModelInfo(m);
    if (info && !seen.has(info.id)) {
      seen.add(info.id);
      models.push(info);
    }
  }
  models.sort((a, b) => (versionOf(b.id) ?? 0) - (versionOf(a.id) ?? 0) || a.id.localeCompare(b.id));
  modelCache = { key, at: Date.now(), models };
  listFailure = null;
  return models;
}

/**
 * Modelos disponíveis para a chave atual (cache de 1 h). Lista vazia sem chave.
 * @throws o erro do SDK quando a listagem falha (falhas ficam em cache por 1 min).
 */
export async function listAvailableModels(force = false): Promise<ModelInfo[]> {
  if (config.mock) return mockModels();
  const ai = getClient();
  if (!ai) return [];
  const key = clientKey;
  const now = Date.now();
  if (!force && modelCache && modelCache.key === key && now - modelCache.at < MODEL_LIST_TTL_MS) {
    return modelCache.models.map((m) => ({ ...m, roles: [...m.roles] }));
  }
  if (!force && listFailure && listFailure.key === key && now - listFailure.at < MODEL_LIST_FAILURE_TTL_MS) {
    throw listFailure.error;
  }
  if (!listInflight) {
    listInflight = fetchModelList(ai, key)
      .catch((error: unknown) => {
        listFailure = { key, at: Date.now(), error };
        throw error;
      })
      .finally(() => {
        listInflight = null;
      });
  }
  const models = await listInflight;
  return models.map((m) => ({ ...m, roles: [...m.roles] }));
}

function overrideFor(role: ModelRole): string {
  let fromSettings = '';
  try {
    fromSettings = getSettings().models[role] ?? '';
  } catch {
    // Banco indisponível: segue com o .env.
  }
  return stripPrefix(fromSettings || config.models[role] || '');
}

/**
 * Modelos candidatos para uma função, na ordem em que devem ser tentados (escolha do usuário primeiro,
 * depois a lista de preferência filtrada pelo catálogo, depois a heurística). Modelos em cooldown
 * (cota estourada há pouco) vão para o fim. Síncrono: usa o catálogo em cache — sem cache,
 * devolve a lista de preferência estática (e dispara uma atualização em segundo plano).
 */
export function getModelFallbacks(role: ModelRole): string[] {
  const cached = modelCache && modelCache.key === clientKey ? modelCache.models : null;
  if (!cached && !config.mock && !listInflight) {
    void listAvailableModels().catch(() => undefined);
  }
  let ordered: string[];
  const candidates = cached?.filter((m) => m.roles.includes(role)).map((m) => m.id) ?? [];
  if (candidates.length > 0) {
    ordered = rankModelsForRole(role, candidates);
  } else {
    ordered = [...PREFERRED_MODELS[role]];
    if (role === 'chat') ordered.push(...PREFERRED_MODELS.fast);
    if (role === 'fast') ordered.push(...PREFERRED_MODELS.chat);
  }
  const override = overrideFor(role);
  if (override) ordered = [override, ...ordered.filter((m) => m !== override)];
  const ready = ordered.filter((m) => !inCooldown(m));
  const cooling = ordered.filter((m) => inCooldown(m));
  return [...ready, ...cooling];
}

/** Modelo a usar para a função: escolha do usuário (settings/.env) ou o melhor disponível. */
export async function resolveModel(role: ModelRole): Promise<string> {
  const override = overrideFor(role);
  if (override) return override;
  if (config.mock) return PREFERRED_MODELS[role][0];
  if (getClient()) {
    try {
      await listAvailableModels();
    } catch {
      // Listagem indisponível: usa a ordem estática de preferência.
    }
  }
  return getModelFallbacks(role)[0] ?? PREFERRED_MODELS[role][0];
}

/** Modelo efetivo por função (após resolução automática). Vazio sem chave fora do modo demonstração. */
export async function getActiveModels(): Promise<Partial<Record<ModelRole, string>>> {
  if (!config.mock && !getClient()) return {};
  const entries = await Promise.all(
    ROLES.map(async (role) => {
      try {
        return [role, await resolveModel(role)] as const;
      } catch {
        return null;
      }
    }),
  );
  const result: Partial<Record<ModelRole, string>> = {};
  for (const entry of entries) if (entry) result[entry[0]] = entry[1];
  return result;
}

// ─── Geração ─────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface GenerateOptions {
  /** Cancelamento externo (ex.: usuário parou a geração). */
  signal?: AbortSignal;
  /** Tempo máximo por tentativa (padrão 60 s). */
  timeoutMs?: number;
  /** Quantos modelos tentar no máximo (padrão 3). */
  maxAttempts?: number;
}

/**
 * `models.generateContent` com troca automática de modelo em cota/404/5xx.
 * @throws GeminiError('no_api_key') sem chave; o último erro do SDK quando todas as tentativas falham.
 */
export async function generateWithFallback(
  role: ModelRole,
  params: Omit<GenerateContentParameters, 'model'>,
  opts: GenerateOptions = {},
): Promise<{ response: GenerateContentResponse; model: string }> {
  const ai = getClient();
  if (!ai) throw new GeminiError('no_api_key', NO_KEY_MESSAGE);
  const first = await resolveModel(role);
  const models = [first, ...getModelFallbacks(role).filter((m) => m !== first)].slice(0, Math.max(1, opts.maxAttempts ?? 3));
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let lastError: unknown = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Cancelado', 'AbortError');
    const timeout = AbortSignal.timeout(timeoutMs);
    const abortSignal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const response = await ai.models.generateContent({
        ...params,
        model,
        config: { ...params.config, abortSignal },
      });
      return { response, model };
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new GeminiError('provider', 'O Gemini demorou demais para responder. Tente de novo em instantes.', { cause: error });
      }
      lastError = error;
      if (!isRetryableModelError(error)) throw error;
      reportModelFailure(model, error);
      if (i < models.length - 1) await sleep(300 * (i + 1), opts.signal);
    }
  }
  throw lastError ?? new GeminiError('internal', 'Nenhum modelo do Gemini disponível.');
}

function mockText(prompt: string | Content[], json: boolean): string {
  if (json) return '{}';
  const text =
    typeof prompt === 'string'
      ? prompt
      : prompt
          .flatMap((c) => c.parts ?? [])
          .map((p) => p.text ?? '')
          .join(' ');
  const topic = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return (
    'Modo demonstração: esta é uma resposta simulada do Lärk' +
    (topic ? ` sobre “${topic}${text.length > 80 ? '…' : ''}”` : '') +
    '. Toda grande conversa começa com uma pergunta bem feita — configure a chave do Google AI Studio e eu respondo de verdade.'
  );
}

/** Geração de texto simples (uma chamada, sem ferramentas), com fallback de modelo em 429/404/503. */
export async function generateText(opts: {
  system?: string;
  prompt: string | Content[];
  role?: 'chat' | 'fast';
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  if (config.mock) return mockText(opts.prompt, Boolean(opts.json));
  const { response } = await generateWithFallback(
    opts.role ?? 'chat',
    {
      contents: opts.prompt,
      config: {
        ...(opts.system ? { systemInstruction: opts.system } : {}),
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      },
    },
    { signal: opts.signal, timeoutMs: opts.timeoutMs },
  );
  const text = response.text ?? '';
  if (!text) {
    const blocked = response.promptFeedback?.blockReason;
    if (blocked) throw new GeminiError('provider', `O Gemini bloqueou este conteúdo por segurança (${blocked}).`);
  }
  return text;
}
