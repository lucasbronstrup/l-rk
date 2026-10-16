/**
 * Embeddings do Gemini para a busca semântica da memória.
 *
 * - `embed()` gera vetores normalizados (Float32) em lote; devolve null em modo demonstração,
 *   sem chave, sem modelo de embedding ou em caso de erro (com log discreto).
 * - `startEmbeddingWorker()` preenche, em segundo plano, os embeddings que faltam em memórias e
 *   mensagens (lotes de até 50, a cada ~15 s, com backoff exponencial em 429) e refaz os vetores
 *   gerados por um modelo diferente do atual.
 *
 * Estados de `embedding_model` nas tabelas `memories`/`messages`:
 *   NULL            → pendente;
 *   '<modelo>'      → pronto (com `embedding`);
 *   'skip'          → mensagem curta/sistema, não vale indexar (volta a NULL se o conteúdo mudar);
 *   'failed:<mod.>' → a API recusou o conteúdo (volta a NULL se o conteúdo mudar).
 */
import type { GoogleGenAI } from '@google/genai';
import { db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { config } from '../config.js';
import { getClient, resolveModel } from '../llm/gemini.js';
import { getApiKey } from './settings.js';
import { normalizeVector, vectorCache, vectorKey, vectorToBlob } from './vectors.js';

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

/** Dimensão pedida ao modelo (Matryoshka): ótimo equilíbrio entre qualidade, disco e RAM. */
export const EMBEDDING_DIMENSIONS = 768;
/** Mensagens menores que isso não carregam conteúdo suficiente para busca semântica. */
export const MIN_MESSAGE_CHARS = 20;

const MAX_INPUT_CHARS = 4000;
const MAX_BATCH = 50;
const TICK_MS = 15_000;
const QUERY_TIMEOUT_MS = 8_000;
const BATCH_TIMEOUT_MS = 60_000;
const SKIP = 'skip';
const FAILED_PREFIX = 'failed:';

// ─── Log discreto ────────────────────────────────────────────────────────

const lastLogged = new Map<string, number>();
function quietWarn(message: string): void {
  const now = Date.now();
  if (now - (lastLogged.get(message) ?? 0) < 10 * 60_000) return;
  lastLogged.set(message, now);
  console.warn(`[embeddings] ${message}`);
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status;
  const message = error instanceof Error ? error.message : String(error);
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(message)) return 429;
  if (/INVALID_ARGUMENT|\b400\b/i.test(message)) return 400;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : String(error);
}

// ─── Chamada à API ───────────────────────────────────────────────────────

/** Modelos que rejeitaram `outputDimensionality` (descoberto em tempo de execução). */
const noDimensionModels = new Set<string>();

function supportsDimensions(model: string): boolean {
  return !noDimensionModels.has(model) && !/(^|\/)embedding-001$/.test(model);
}

async function callEmbedApi(
  client: GoogleGenAI,
  model: string,
  texts: string[],
  taskType: EmbeddingTaskType,
  timeoutMs: number,
): Promise<Float32Array[]> {
  const contents = texts.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));
  const request = (withDims: boolean) =>
    client.models.embedContent({
      model,
      contents,
      config: {
        taskType,
        ...(withDims ? { outputDimensionality: EMBEDDING_DIMENSIONS } : {}),
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
    });

  let response;
  const withDims = supportsDimensions(model);
  try {
    response = await request(withDims);
  } catch (error) {
    if (withDims && errorStatus(error) === 400 && /dimension/i.test(errorMessage(error))) {
      noDimensionModels.add(model);
      response = await request(false);
    } else {
      throw error;
    }
  }

  const embeddings = response.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(`resposta com ${embeddings.length} vetores para ${texts.length} textos`);
  }
  return embeddings.map((e, i) => {
    const vec = normalizeVector(e.values ?? []);
    if (!vec) throw new Error(`vetor inválido na posição ${i}`);
    return vec;
  });
}

interface EmbeddingTarget {
  client: GoogleGenAI;
  model: string;
}

/** Cliente + modelo de embedding, ou null se indisponível (mock, sem chave, sem modelo). */
async function resolveTarget(): Promise<EmbeddingTarget | null> {
  if (config.mock) return null;
  const client = getClient();
  if (!client) return null;
  const model = (await resolveModel('embedding'))?.trim();
  if (!model) return null;
  return { client, model };
}

// ─── API pública ─────────────────────────────────────────────────────────

/** Até quando a API está em pausa por limite de uso (429). */
let pausedUntil = 0;

/**
 * Como `embed`, mas informa o modelo usado (necessário para comparar só vetores do mesmo espaço).
 */
export async function embedDetailed(
  texts: string[],
  taskType: EmbeddingTaskType = 'RETRIEVAL_DOCUMENT',
): Promise<{ model: string; vectors: Float32Array[] } | null> {
  if (texts.length === 0) return null;
  if (Date.now() < pausedUntil) return null;
  try {
    const target = await resolveTarget();
    if (!target) return null;
    const vectors = await callEmbedApi(
      target.client,
      target.model,
      texts,
      taskType,
      taskType === 'RETRIEVAL_QUERY' ? QUERY_TIMEOUT_MS : BATCH_TIMEOUT_MS,
    );
    return { model: target.model, vectors };
  } catch (error) {
    quietWarn(`falha ao gerar embeddings: ${errorMessage(error)}`);
    return null;
  }
}

/** Vetores normalizados (um por texto) ou null se sem chave/mock/erro. */
export async function embed(
  texts: string[],
  taskType: EmbeddingTaskType = 'RETRIEVAL_DOCUMENT',
): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  return (await embedDetailed(texts, taskType))?.vectors ?? null;
}

// ─── Worker em segundo plano ─────────────────────────────────────────────

type ItemType = 'memory' | 'message';
interface Job {
  type: ItemType;
  seq: number;
  content: string;
}

const markIneligibleStmt = db.prepare(
  `UPDATE messages SET embedding_model = '${SKIP}'
   WHERE embedding_model IS NULL AND (role NOT IN ('user', 'assistant') OR length(trim(content)) < ${MIN_MESSAGE_CHARS})`,
);
const pendingMemoriesStmt = db.prepare(
  'SELECT seq, content FROM memories WHERE embedding_model IS NULL AND archived = 0 ORDER BY seq LIMIT ?',
);
const staleMemoriesStmt = db.prepare(
  `SELECT seq, content FROM memories
   WHERE (embedding_model < ? OR embedding_model > ?) AND embedding IS NOT NULL AND archived = 0 LIMIT ?`,
);
const pendingMessagesStmt = db.prepare(
  `SELECT seq, content FROM messages
   WHERE embedding_model IS NULL AND role IN ('user', 'assistant') AND length(trim(content)) >= ${MIN_MESSAGE_CHARS}
   ORDER BY seq DESC LIMIT ?`,
);
const staleMessagesStmt = db.prepare(
  `SELECT seq, content FROM messages
   WHERE (embedding_model < ? OR embedding_model > ?) AND embedding IS NOT NULL LIMIT ?`,
);
const storeStmts = {
  memory: db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE seq = ? AND content = ?'),
  message: db.prepare('UPDATE messages SET embedding = ?, embedding_model = ? WHERE seq = ? AND content = ?'),
};
const failStmts = {
  memory: db.prepare('UPDATE memories SET embedding = NULL, embedding_model = ? WHERE seq = ? AND content = ?'),
  message: db.prepare('UPDATE messages SET embedding = NULL, embedding_model = ? WHERE seq = ? AND content = ?'),
};

let timer: NodeJS.Timeout | null = null;
let soonTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let running = false;
let backoffMs = 0;
let batchSize = MAX_BATCH;
/** Modelo para o qual já não restam vetores de outros modelos (evita varrer a cada ciclo). */
let staleClearedFor: string | null = null;
let lastApiKey = '';
/** Já houve um lote bem-sucedido neste processo (a chave e o modelo funcionam). */
let hadSuccess = false;
/** Erros 400 que dizem respeito à requisição (chave, modelo, permissão), não ao conteúdo. */
const REQUEST_LEVEL_ERROR = /api.?key|permission|unauthori|credential|model/i;

/** Itens a processar: memórias primeiro (mais valiosas), depois mensagens recentes. */
function collectJobs(model: string, limit: number): Job[] {
  markIneligibleStmt.run();
  const jobs: Job[] = [];
  const take = (type: ItemType, rows: unknown[]) => {
    for (const r of rows as { seq: number; content: string }[]) jobs.push({ type, seq: r.seq, content: r.content });
  };
  take('memory', pendingMemoriesStmt.all(limit));
  if (jobs.length < limit) take('message', pendingMessagesStmt.all(limit - jobs.length));
  if (jobs.length < limit && staleClearedFor !== model) {
    const before = jobs.length;
    take('memory', staleMemoriesStmt.all(model, model, limit - jobs.length));
    if (jobs.length < limit) take('message', staleMessagesStmt.all(model, model, limit - jobs.length));
    if (jobs.length === before) staleClearedFor = model;
  }
  return jobs;
}

function storeVectors(jobs: Job[], vectors: Float32Array[], model: string): number {
  let stored = 0;
  db.transaction(() => {
    jobs.forEach((job, i) => {
      const vec = vectors[i];
      const changes = storeStmts[job.type].run(vectorToBlob(vec), model, job.seq, job.content).changes;
      if (changes > 0) {
        vectorCache.set(vectorKey(model, job.type, job.seq), vec);
        stored++;
      }
    });
  })();
  return stored;
}

/**
 * Executa um ciclo do worker: processa um lote de itens sem embedding.
 * Retorna quantos vetores foram gravados. Exportado para testes e para forçar um ciclo.
 */
export async function runEmbeddingCycle(): Promise<number> {
  if (running || Date.now() < pausedUntil) return 0;
  running = true;
  let jobs: Job[] = [];
  let target: EmbeddingTarget | null = null;
  try {
    target = await resolveTarget();
    if (!target) return 0;
    jobs = collectJobs(target.model, batchSize);
    if (jobs.length === 0) return 0;
    const vectors = await callEmbedApi(
      target.client,
      target.model,
      jobs.map((j) => j.content),
      'RETRIEVAL_DOCUMENT',
      BATCH_TIMEOUT_MS,
    );
    const stored = storeVectors(jobs, vectors, target.model);
    hadSuccess = true;
    backoffMs = 0;
    batchSize = Math.min(MAX_BATCH, batchSize * 2);
    return stored;
  } catch (error) {
    const status = errorStatus(error);
    if (status === 429) {
      backoffMs = backoffMs ? Math.min(backoffMs * 2, 30 * 60_000) : 60_000;
      pausedUntil = Date.now() + backoffMs;
      quietWarn(`limite de uso atingido; nova tentativa em ${Math.round(backoffMs / 1000)} s.`);
    } else if (status === 400 && target && jobs.length > 0 && hadSuccess && !REQUEST_LEVEL_ERROR.test(errorMessage(error))) {
      // Conteúdo recusado (a API funciona para outros itens): divide o lote até isolar o item
      // problemático e então o marca, para não travar a fila.
      if (jobs.length === 1) {
        const [job] = jobs;
        failStmts[job.type].run(`${FAILED_PREFIX}${target.model}`, job.seq, job.content);
        batchSize = MAX_BATCH;
      } else {
        batchSize = Math.max(1, Math.floor(jobs.length / 2));
      }
      quietWarn(`a API recusou um lote (${errorMessage(error)}); reduzindo o lote.`);
    } else {
      backoffMs = backoffMs ? Math.min(backoffMs * 2, 10 * 60_000) : 30_000;
      pausedUntil = Date.now() + backoffMs;
      quietWarn(`falha no worker: ${errorMessage(error)}; nova tentativa em ${Math.round(backoffMs / 1000)} s.`);
    }
    return 0;
  } finally {
    running = false;
  }
}

function scheduleSoon(delayMs = 3_000): void {
  if (!timer || soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = null;
    void runEmbeddingCycle();
  }, delayMs);
  soonTimer.unref?.();
}

/** Inicia o worker (idempotente). Não segura o processo aberto. */
export function startEmbeddingWorker(): void {
  if (timer) return;
  lastApiKey = getApiKey();
  timer = setInterval(() => void runEmbeddingCycle(), TICK_MS);
  timer.unref?.();
  unsubscribe = bus.subscribe((event) => {
    if (event.type === 'memory' && event.action !== 'deleted') scheduleSoon();
    else if (event.type === 'conversation' && event.action === 'updated') scheduleSoon();
    else if (event.type === 'settings') {
      // Nova chave ou modelo: zera o backoff e reavalia vetores antigos.
      const key = getApiKey();
      if (key !== lastApiKey) {
        lastApiKey = key;
        backoffMs = 0;
        pausedUntil = 0;
      }
      staleClearedFor = null;
      scheduleSoon();
    }
  });
  scheduleSoon(2_000);
}

/** Para o worker (encerramento do servidor e testes). */
export function stopEmbeddingWorker(): void {
  if (timer) clearInterval(timer);
  if (soonTimer) clearTimeout(soonTimer);
  unsubscribe?.();
  timer = null;
  soonTimer = null;
  unsubscribe = null;
}

/** Zera o estado de backoff/lote (testes). */
export function resetEmbeddingState(): void {
  pausedUntil = 0;
  backoffMs = 0;
  batchSize = MAX_BATCH;
  staleClearedFor = null;
  hadSuccess = false;
  noDimensionModels.clear();
}
