/**
 * Configurações do Lärk persistidas na tabela `settings` (uma linha por campo, valor em JSON).
 * A chave do Gemini fica numa linha separada (`gemini_api_key`) e nunca sai do servidor:
 * `getSettings()` expõe apenas `hasApiKey`.
 */
import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { bus } from '../lib/bus.js';
import { nowIso } from '../lib/ids.js';
import type { Settings, SettingsUpdate } from '../../shared/types.js';

const API_KEY_KEY = 'gemini_api_key';

/** Campos de `Settings` persistidos (tudo exceto o derivado `hasApiKey`). */
type StoredSettings = Omit<Settings, 'hasApiKey'>;
type StoredKey = keyof StoredSettings;

/** Erro de validação com mensagem pronta para o usuário (as rotas devem responder 400). */
export class SettingsValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function defaultTimeZone(): string {
  return isValidTimeZone(config.timezone) ? config.timezone : 'America/Sao_Paulo';
}

export const DEFAULT_SETTINGS: Readonly<StoredSettings> = Object.freeze<StoredSettings>({
  userName: '',
  personaNotes: '',
  timezone: defaultTimeZone(),
  models: { chat: '', fast: '', tts: '', live: '', embedding: '' },
  voiceName: 'Charon',
  voiceStyle:
    'Palestrante carismático e experiente: voz grave, calorosa e confiante, ritmo envolvente, pausas de efeito antes das ideias centrais',
  speakInChat: false,
  showThoughts: true,
  computer: { enabled: true, approvalMode: 'ask', favoritePaths: [] },
  proactive: {
    enabled: true,
    checkInEveryHours: 6,
    quietHoursStart: '23:00',
    quietHoursEnd: '07:00',
    morningBriefing: true,
  },
});

// ─── Validação ──────────────────────────────────────────────────────────

const hhmm = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use o formato HH:MM (ex.: 23:00)');
const modelId = z.string().trim().max(200, 'nome de modelo longo demais');

const modelsSchema = z.object({
  chat: modelId,
  fast: modelId,
  tts: modelId,
  live: modelId,
  embedding: modelId,
});

const computerSchema = z.object({
  enabled: z.boolean(),
  approvalMode: z.enum(['ask', 'dangerous-only', 'never'], { error: 'modo de aprovação inválido' }),
  favoritePaths: z
    .array(z.string().trim().min(1, 'caminho vazio').max(1024, 'caminho longo demais'))
    .max(100, 'no máximo 100 pastas favoritas'),
});

const proactiveSchema = z.object({
  enabled: z.boolean(),
  checkInEveryHours: z
    .number({ error: 'informe um número de horas' })
    .min(0.25, 'mínimo de 15 minutos (0.25 h)')
    .max(720, 'máximo de 720 horas'),
  quietHoursStart: hhmm,
  quietHoursEnd: hhmm,
  morningBriefing: z.boolean(),
});

/** Esquema de cada campo completo (usado para validar valores lidos do banco). */
const fieldSchemas = {
  userName: z.string().trim().max(80, 'nome longo demais (máx. 80 caracteres)'),
  personaNotes: z.string().max(4000, 'notas de personalidade longas demais (máx. 4000 caracteres)'),
  timezone: z.string().trim().refine(isValidTimeZone, 'fuso horário IANA inválido (ex.: America/Sao_Paulo)'),
  models: modelsSchema,
  voiceName: z.string().trim().min(1, 'escolha uma voz').max(64, 'nome de voz longo demais'),
  voiceStyle: z.string().trim().max(1000, 'estilo de voz longo demais (máx. 1000 caracteres)'),
  speakInChat: z.boolean(),
  showThoughts: z.boolean(),
  computer: computerSchema,
  proactive: proactiveSchema,
} satisfies Record<StoredKey, z.ZodType>;

/** Corpo aceito por updateSettings (parcial; objetos aninhados também parciais). */
const updateSchema = z.object({
  userName: fieldSchemas.userName.optional(),
  personaNotes: fieldSchemas.personaNotes.optional(),
  timezone: fieldSchemas.timezone.optional(),
  models: modelsSchema.partial().optional(),
  voiceName: fieldSchemas.voiceName.optional(),
  voiceStyle: fieldSchemas.voiceStyle.optional(),
  speakInChat: z.boolean().optional(),
  showThoughts: z.boolean().optional(),
  computer: computerSchema.partial().optional(),
  proactive: proactiveSchema.partial().optional(),
  apiKey: z.string().trim().max(512, 'chave de API longa demais').optional(),
});

const FIELD_LABELS: Record<string, string> = {
  userName: 'nome',
  personaNotes: 'notas de personalidade',
  timezone: 'fuso horário',
  models: 'modelos',
  voiceName: 'voz',
  voiceStyle: 'estilo de voz',
  speakInChat: 'responder com voz no chat',
  showThoughts: 'mostrar raciocínio',
  computer: 'acesso ao computador',
  proactive: 'proatividade',
  apiKey: 'chave de API',
  enabled: 'ativado',
  approvalMode: 'modo de aprovação',
  favoritePaths: 'pastas favoritas',
  checkInEveryHours: 'intervalo de cobranças',
  quietHoursStart: 'início do silêncio',
  quietHoursEnd: 'fim do silêncio',
  morningBriefing: 'briefing matinal',
};

function describeIssues(error: z.ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path
      .filter((p): p is string => typeof p === 'string')
      .map((p) => FIELD_LABELS[p] ?? p)
      .join(' › ');
    const message = issue.code === 'invalid_type' ? 'tipo de valor inválido' : issue.message;
    return path ? `${path}: ${message}` : message;
  });
  return `Configurações inválidas — ${parts.join('; ')}.`;
}

// ─── Acesso ao banco ─────────────────────────────────────────────────────

const selectAllStmt = db.prepare('SELECT key, value FROM settings');
const selectOneStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertStmt = db.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
);
const deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?');

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Lê um valor bruto da tabela `settings` (para estados internos de outros módulos). */
export function readSettingValue<T = unknown>(key: string): T | undefined {
  const row = selectOneStmt.get(key) as { value: string } | undefined;
  return row ? (parseJson(row.value) as T | undefined) : undefined;
}

/** Grava um valor bruto (JSON) na tabela `settings`. Não publica eventos. */
export function writeSettingValue(key: string, value: unknown): void {
  if (key === API_KEY_KEY) throw new Error('Use updateSettings({ apiKey }) para alterar a chave.');
  upsertStmt.run(key, JSON.stringify(value), nowIso());
  if (key in DEFAULT_SETTINGS) cached = null;
}

let cached: StoredSettings | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Valida um campo lido do banco; objetos são mesclados sobre o padrão (campos novos ganham default). */
function sanitizeField<K extends StoredKey>(key: K, raw: unknown): StoredSettings[K] {
  const fallback = DEFAULT_SETTINGS[key];
  let candidate: unknown = raw;
  if (isRecord(fallback)) {
    if (!isRecord(raw)) return structuredClone(fallback) as StoredSettings[K];
    // Mescla campo a campo, descartando apenas os subcampos inválidos.
    const merged: Record<string, unknown> = { ...(fallback as Record<string, unknown>) };
    const schema = fieldSchemas[key] as unknown as z.ZodObject<Record<string, z.ZodType>>;
    for (const [sub, value] of Object.entries(raw)) {
      const subSchema = schema.shape[sub];
      if (!subSchema) continue;
      const parsed = subSchema.safeParse(value);
      if (parsed.success) merged[sub] = parsed.data;
    }
    candidate = merged;
  }
  const parsed = fieldSchemas[key].safeParse(candidate);
  return (parsed.success ? parsed.data : structuredClone(fallback)) as StoredSettings[K];
}

function loadStored(): StoredSettings {
  if (cached) return cached;
  const rows = selectAllStmt.all() as { key: string; value: string }[];
  const raw = new Map(rows.map((r) => [r.key, parseJson(r.value)]));
  const result = structuredClone(DEFAULT_SETTINGS) as StoredSettings;
  for (const key of Object.keys(DEFAULT_SETTINGS) as StoredKey[]) {
    if (raw.has(key)) (result as Record<StoredKey, unknown>)[key] = sanitizeField(key, raw.get(key));
  }
  cached = result;
  return result;
}

// ─── API pública ─────────────────────────────────────────────────────────

/** Chave do Gemini: a salva pela interface tem prioridade sobre a do .env. */
export function getApiKey(): string {
  const stored = readSettingValue<string>(API_KEY_KEY);
  return (typeof stored === 'string' && stored.trim()) || config.geminiApiKey;
}

/** Configurações atuais (cópia). Nunca inclui a chave, apenas `hasApiKey`. */
export function getSettings(): Settings {
  return { ...structuredClone(loadStored()), hasApiKey: Boolean(getApiKey()) };
}

/**
 * Aplica uma atualização parcial (merge profundo), valida, persiste e publica `{type:'settings'}`.
 * `apiKey: ''` remove a chave salva (volta a valer a do .env, se houver).
 * @throws SettingsValidationError quando algum campo é inválido.
 */
export function updateSettings(patch: SettingsUpdate): Settings {
  const parsed = updateSchema.safeParse(patch ?? {});
  if (!parsed.success) throw new SettingsValidationError(describeIssues(parsed.error));
  const { apiKey, ...changes } = parsed.data;

  const current = loadStored();
  const next: StoredSettings = structuredClone(current);
  const touched = new Set<StoredKey>();

  for (const [key, value] of Object.entries(changes) as [StoredKey, unknown][]) {
    if (value === undefined) continue;
    const base = next[key];
    (next as Record<StoredKey, unknown>)[key] = isRecord(base) && isRecord(value) ? { ...base, ...value } : value;
    touched.add(key);
  }

  const now = nowIso();
  const persist = db.transaction(() => {
    for (const key of touched) upsertStmt.run(key, JSON.stringify(next[key]), now);
    if (apiKey !== undefined) {
      if (apiKey) upsertStmt.run(API_KEY_KEY, JSON.stringify(apiKey), now);
      else deleteStmt.run(API_KEY_KEY);
    }
  });
  persist();
  cached = null;

  const settings = getSettings();
  bus.publish({ type: 'settings', settings });
  return settings;
}
