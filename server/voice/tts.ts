/**
 * Voz humanizada do Lärk fora do modo ao vivo: Gemini TTS → WAV.
 *
 * - Normaliza o texto para fala (sem markdown, código ou URLs) e limita o tamanho.
 * - Usa o modelo de TTS resolvido automaticamente, com troca de modelo em cota/404/5xx.
 * - Junta as partes de áudio (WAV ou PCM cru, conforme o modelo) num WAV com cabeçalho correto.
 * - Cache LRU em memória (texto + voz + direção de estilo) e deduplicação de pedidos simultâneos.
 * - Nunca lança: devolve null (com o motivo registrado) e o cliente cai para a voz do navegador.
 */
import { createHash } from 'node:crypto';
import { Modality } from '@google/genai';
import { config } from '../config.js';
import { classifyGeminiError, generateWithFallback, getClient, parseGeminiError } from '../llm/gemini.js';
import { getSettings } from '../memory/settings.js';
import { VOICE_DIRECTION } from '../agent/persona.js';
import { resolveVoiceName } from './voices.js';
import { audioPartsToWav } from './wav.js';
import type { Settings } from '../../shared/types.js';

/** Limite de caracteres enviados ao TTS por pedido (o cliente já divide textos longos em blocos). */
export const MAX_TTS_CHARS = 4000;
const MAX_STYLE_CHARS = 800;
const TTS_TIMEOUT_MS = 60_000;
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_BYTES = 30 * 1024 * 1024;
/** Pausa após estourar a cota em todos os modelos (evita martelar a API a cada frase). */
const QUOTA_COOLDOWN_MIN_MS = 30_000;
const QUOTA_COOLDOWN_MAX_MS = 10 * 60_000;

export type TtsUnavailableReason = 'mock' | 'no_api_key' | 'quota' | 'empty' | 'provider' | 'internal';

export type TtsOutcome =
  | { ok: true; wav: Buffer; model: string; cached: boolean }
  | { ok: false; reason: TtsUnavailableReason; message: string };

export interface TtsOptions {
  /** Voz pré-definida do Gemini (padrão: settings.voiceName). */
  voiceName?: string;
  /** Direção de estilo (padrão: VOICE_DIRECTION(settings)). */
  style?: string;
}

export interface TtsStatus {
  available: boolean;
  lastModel: string | null;
  lastSuccessAt: string | null;
  lastFailure: { reason: TtsUnavailableReason; message: string; at: string } | null;
  quotaCooldownUntil: string | null;
  cache: { entries: number; bytes: number };
}

// ─── Normalização do texto ───────────────────────────────────────────────

/** Fecha uma linha (título, item de lista) com pontuação para a fala respirar. */
function endSentence(line: string, mark = '.'): string {
  const t = line.trim();
  if (!t) return '';
  return /[.!?…:;,]$/.test(t) ? t : `${t}${mark}`;
}

/** Corta no limite preferindo o fim de uma frase (ou, no pior caso, de uma palavra). */
function cutAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('… '), slice.lastIndexOf('\n'));
  if (sentenceEnd > max * 0.6) return slice.slice(0, sentenceEnd + 1).trim();
  const space = slice.lastIndexOf(' ');
  return `${(space > max * 0.6 ? slice.slice(0, space) : slice).trim()}…`;
}

/**
 * Converte markdown/texto do chat em texto natural para fala: remove blocos de código, código
 * inline vira texto, links viram só o rótulo, URLs, imagens, HTML, emojis e marcações somem;
 * títulos e itens de lista ganham pontuação. Limita a `maxChars` (padrão 4000).
 */
export function normalizeForSpeech(input: string, maxChars = MAX_TTS_CHARS): string {
  if (!input) return '';
  let s = input.replace(/\r\n?/g, '\n');
  s = s.replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, '');
  s = s.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  s = s.replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1');
  s = s.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, '');
  s = s.replace(/<https?:\/\/[^>]+>/gi, ' ');
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s)]+?(?=[.,;:!?]*(?:\s|$|\)))/gi, ' ');
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ');
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, (_m, h: string) => endSentence(h));
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/gm, (_m, item: string) => endSentence(item, ';'));
  s = s.replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*(?::?-{3,}:?)?[ \t]*$/gm, '');
  s = s.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) =>
    endSentence(
      row
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .join(', '),
    ),
  );
  s = s.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1$2');
  s = s.replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?=\W|$)/g, '$1$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  s = s.replace(/[*#>|`~]+/g, ' ');
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/ +([.,;:!?…])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cutAtBoundary(s, Math.max(1, maxChars));
}

// ─── Direção de estilo e prompt ──────────────────────────────────────────

function compact(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Direção de voz: o estilo pedido, senão a direção da persona, senão o estilo das configurações. */
export function resolveVoiceDirection(settings: Settings, style?: string | null): string {
  const explicit = compact(style ?? '', MAX_STYLE_CHARS);
  if (explicit) return explicit;
  try {
    const direction = compact(VOICE_DIRECTION(settings) ?? '', MAX_STYLE_CHARS);
    if (direction) return direction;
  } catch {
    // A persona é opcional para a voz: segue com o estilo salvo.
  }
  return compact(settings.voiceStyle, MAX_STYLE_CHARS) || 'Palestrante carismático, voz calorosa e confiante, pausas de efeito';
}

/** Prompt do TTS: instruções de leitura separadas do texto para que o modelo não as leia em voz alta. */
export function buildTtsPrompt(text: string, direction: string): string {
  return [
    'Leia em voz alta, em português do Brasil, somente o texto que aparece depois de "TEXTO:".',
    'Não leia estas instruções e não acrescente nem omita palavras.',
    `Estilo de voz: ${direction}`,
    '',
    'TEXTO:',
    text,
  ].join('\n');
}

// ─── Cache LRU ───────────────────────────────────────────────────────────

interface CacheEntry {
  wav: Buffer;
  model: string;
}

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;
const inflight = new Map<string, Promise<TtsOutcome>>();

function cacheKey(text: string, voice: string, direction: string): string {
  return createHash('sha256').update(`${voice}\u0000${direction}\u0000${text}`).digest('hex');
}

function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  // Reinsere para marcar como usado recentemente.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (entry.wav.length > CACHE_MAX_BYTES) return;
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key);
    cacheBytes -= previous.wav.length;
  }
  cache.set(key, entry);
  cacheBytes += entry.wav.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const removed = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (removed) cacheBytes -= removed.wav.length;
  }
}

/** Esvazia o cache de áudio (testes, troca de chave). */
export function clearTtsCache(): void {
  cache.clear();
  cacheBytes = 0;
}

// ─── Estado para o health ────────────────────────────────────────────────

let lastModel: string | null = null;
let lastSuccessAt: string | null = null;
let lastFailure: TtsStatus['lastFailure'] = null;
let quotaCooldownUntil = 0;
let lastLoggedFailure = '';

function recordFailure(reason: TtsUnavailableReason, message: string): TtsOutcome {
  lastFailure = { reason, message, at: new Date().toISOString() };
  // Registra uma vez por tipo de falha seguida, sem poluir o terminal a cada frase.
  const signature = `${reason}:${message}`;
  if (reason !== 'empty' && reason !== 'mock' && signature !== lastLoggedFailure) {
    lastLoggedFailure = signature;
    console.warn(`[Lärk] Voz do Gemini indisponível (${reason}): ${message} — o navegador assume a fala.`);
  }
  return { ok: false, reason, message };
}

/** Situação da voz do Gemini (para o health e diagnósticos). */
export function getTtsStatus(): TtsStatus {
  const now = Date.now();
  return {
    available: !config.mock && Boolean(getClient()) && quotaCooldownUntil <= now,
    lastModel,
    lastSuccessAt,
    lastFailure,
    quotaCooldownUntil: quotaCooldownUntil > now ? new Date(quotaCooldownUntil).toISOString() : null,
    cache: { entries: cache.size, bytes: cacheBytes },
  };
}

/** Zera cooldown, cache e diagnóstico (usado em testes e quando a chave muda). */
export function resetTtsState(): void {
  clearTtsCache();
  inflight.clear();
  lastModel = null;
  lastSuccessAt = null;
  lastFailure = null;
  quotaCooldownUntil = 0;
  lastLoggedFailure = '';
}

// ─── Síntese ─────────────────────────────────────────────────────────────

async function generate(text: string, voiceName: string, direction: string): Promise<TtsOutcome> {
  try {
    const { response, model } = await generateWithFallback(
      'tts',
      {
        contents: [{ role: 'user', parts: [{ text: buildTtsPrompt(text, direction) }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      },
      { timeoutMs: TTS_TIMEOUT_MS, maxAttempts: 3 },
    );
    const parts = (response.candidates ?? [])
      .flatMap((c) => c.content?.parts ?? [])
      .filter((p) => typeof p.inlineData?.data === 'string' && p.inlineData.data.length > 0)
      .map((p) => ({ mimeType: p.inlineData?.mimeType, data: p.inlineData?.data ?? '' }));
    const wav = audioPartsToWav(parts);
    if (!wav) {
      const blocked = response.promptFeedback?.blockReason;
      const finish = response.candidates?.[0]?.finishReason;
      return recordFailure(
        'provider',
        blocked
          ? `O Gemini bloqueou este texto por segurança (${blocked}).`
          : `O modelo ${model} não devolveu áudio${finish ? ` (${finish})` : ''}.`,
      );
    }
    lastModel = model;
    lastSuccessAt = new Date().toISOString();
    lastFailure = null;
    lastLoggedFailure = '';
    return { ok: true, wav, model, cached: false };
  } catch (error) {
    const { code, message } = classifyGeminiError(error);
    if (code === 'quota') {
      const suggested = parseGeminiError(error).retryDelayMs ?? 60_000;
      quotaCooldownUntil = Date.now() + Math.min(Math.max(suggested, QUOTA_COOLDOWN_MIN_MS), QUOTA_COOLDOWN_MAX_MS);
    }
    return recordFailure(code, message);
  }
}

/**
 * Como `synthesizeSpeech`, mas informa o motivo quando não há áudio
 * (usado pela rota para o cabeçalho X-Lark-TTS-Reason).
 */
export async function synthesizeSpeechDetailed(text: string, opts: TtsOptions = {}): Promise<TtsOutcome> {
  const clean = normalizeForSpeech(typeof text === 'string' ? text : '');
  if (!/[\p{L}\p{N}]/u.test(clean)) return recordFailure('empty', 'Não há texto legível para falar.');
  if (config.mock) return recordFailure('mock', 'Modo demonstração: a voz do Gemini está desligada.');
  if (!getClient()) return recordFailure('no_api_key', 'Nenhuma chave do Google AI Studio configurada.');
  if (quotaCooldownUntil > Date.now()) {
    return { ok: false, reason: 'quota', message: 'A cota gratuita de voz do Gemini se esgotou por agora.' };
  }

  let settings: Settings;
  try {
    settings = getSettings();
  } catch (error) {
    return recordFailure('internal', `Não consegui ler as configurações: ${error instanceof Error ? error.message : String(error)}`);
  }
  const voiceName = resolveVoiceName(opts.voiceName || settings.voiceName);
  const direction = resolveVoiceDirection(settings, opts.style);
  const key = cacheKey(clean, voiceName, direction);

  const hit = cacheGet(key);
  if (hit) return { ok: true, wav: hit.wav, model: hit.model, cached: true };

  let pending = inflight.get(key);
  if (!pending) {
    pending = generate(clean, voiceName, direction)
      .then((outcome) => {
        if (outcome.ok) cacheSet(key, { wav: outcome.wav, model: outcome.model });
        return outcome;
      })
      .catch((error: unknown) =>
        recordFailure('internal', error instanceof Error ? error.message : String(error)),
      )
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * Sintetiza a fala do Lärk com o Gemini TTS e devolve um WAV.
 * null em modo demonstração, sem chave, com cota esgotada ou em falha do provedor —
 * nesses casos o cliente usa a voz do navegador.
 */
export async function synthesizeSpeech(
  text: string,
  opts: { voiceName?: string; style?: string } = {},
): Promise<{ wav: Buffer; model: string } | null> {
  const outcome = await synthesizeSpeechDetailed(text, opts);
  return outcome.ok ? { wav: outcome.wav, model: outcome.model } : null;
}
