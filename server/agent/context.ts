/**
 * Montagem do contexto de cada turno do Lärk.
 *
 * `buildSystemInstruction()` = persona + blocos gerados na hora:
 *   AGORA (data/hora no fuso do usuário + computador) · PERFIL E MEMÓRIAS ESSENCIAIS ·
 *   MEMÓRIAS RELEVANTES (busca híbrida pela mensagem atual) · PROMESSAS ABERTAS ·
 *   LEMBRETES PRÓXIMOS (48 h) · RESUMO DA CONVERSA ATÉ AQUI.
 * Os ids aparecem como `[id: …]` para o modelo poder atualizar/esquecer itens pelas ferramentas.
 *
 * `toGeminiHistory()` converte as mensagens salvas em `Content[]` do Gemini (user/model).
 */
import os from 'node:os';
import type { Content } from '@google/genai';
import { getSettings } from '../memory/settings.js';
import { getConversation } from '../memory/conversations.js';
import { getCoreMemories, searchMemory } from '../memory/search.js';
import { MEMORY_CATEGORY_LABELS } from '../memory/memories.js';
import { listCommitments } from '../memory/commitments.js';
import { RECURRENCE_LABELS, listReminders } from '../memory/reminders.js';
import { formatLocalDateTime, safeTimeZone } from '../memory/time.js';
import { truncateText } from '../memory/text.js';
import { describeNow, shortDateTime } from '../tools/utility.js';
import { getOsDescription } from '../tools/system.js';
import { ensureKnownFoldersDetected, knownFolders } from '../tools/paths.js';
import { userShell } from '../tools/shell.js';
import { buildPersona, type PersonaMode } from './persona.js';
import type { ChatMessage, Commitment, Memory, MemorySearchHit, Reminder, Settings } from '../../shared/types.js';

/** Quantas mensagens recentes vão literalmente no histórico (as anteriores ficam no resumo/memória). */
export const HISTORY_WINDOW = 40;

/** Texto inserido quando o histórico começaria com uma fala do Lärk (o Gemini espera o usuário primeiro). */
export const CONVERSATION_START_NOTE = '⟦início da conversa — o Lärk falou primeiro⟧';

const CORE_MEMORIES = 24;
const RELEVANT_ITEMS = 12;
const MAX_COMMITMENTS = 15;
const MAX_REMINDERS = 10;
const REMINDER_HORIZON_MS = 48 * 60 * 60_000;
const MACHINE_CACHE_MS = 10 * 60_000;
const OS_DESCRIPTION_TIMEOUT_MS = 2_500;
const SEARCH_TIMEOUT_MS = 10_000;

/** Limites de tamanho por bloco (caracteres), para o contexto não crescer sem controle. */
const LIMITS = {
  core: 5_000,
  relevant: 6_000,
  commitments: 3_000,
  reminders: 1_500,
  summary: 8_000,
} as const;

// ─── Utilidades ──────────────────────────────────────────────────────────

/** Uma linha só, sem espaços repetidos, com tamanho máximo. */
function oneLine(text: string, max: number): string {
  return truncateText(text.replace(/\s+/g, ' ').trim(), max);
}

/** Junta linhas até o limite do bloco, informando quantas ficaram de fora. */
function clampLines(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (used + line.length + 1 > maxChars && kept.length > 0) {
      kept.push(`- (+${lines.length - i} itens omitidos por espaço)`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n');
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function safeSettings(): Settings | null {
  try {
    return getSettings();
  } catch (error) {
    console.warn('[contexto] não consegui ler as configurações:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ─── AGORA: data/hora e computador ───────────────────────────────────────

interface MachineInfo {
  lines: string[];
  at: number;
}
let machineCache: MachineInfo | null = null;

function platformLabel(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}

async function describeMachine(): Promise<string[]> {
  if (machineCache && Date.now() - machineCache.at < MACHINE_CACHE_MS) return machineCache.lines;
  const fallbackOs = `${os.type()} ${os.release()}`;
  const [osName] = await Promise.all([
    withTimeout(getOsDescription(), OS_DESCRIPTION_TIMEOUT_MS, fallbackOs),
    withTimeout(ensureKnownFoldersDetected(), OS_DESCRIPTION_TIMEOUT_MS, undefined),
  ]);
  let username = '';
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USERNAME || process.env.USER || '';
  }
  let shellName = '';
  try {
    shellName = userShell().name;
  } catch {
    shellName = process.platform === 'win32' ? 'PowerShell' : 'sh';
  }
  const lines = [
    `- Computador: "${os.hostname()}" · ${osName || fallbackOs} (${platformLabel(process.platform)}, ${os.arch()})` +
      (username ? ` · usuário do sistema: ${username}` : ''),
    process.platform === 'win32'
      ? `- Terminal: ${shellName} — escreva comandos em sintaxe do PowerShell.`
      : `- Terminal: ${shellName}.`,
  ];
  try {
    const folders = knownFolders()
      .filter((f) => f.exists)
      .map((f) => `${f.label}: ${f.path}`);
    if (folders.length) lines.push(`- Pastas conhecidas: ${folders.join(' · ')}`);
  } catch (error) {
    console.warn('[contexto] pastas conhecidas indisponíveis:', error instanceof Error ? error.message : error);
  }
  machineCache = { lines, at: Date.now() };
  return lines;
}

async function nowBlock(settings: Settings | null, mode: PersonaMode): Promise<string> {
  const tz = safeTimeZone(settings?.timezone);
  const now = describeNow(tz);
  const lines = [
    '# AGORA',
    `- Data e hora local: ${now.local} (${now.period})`,
    `- ISO local com fuso: ${now.iso} · fuso ${now.timezone} (UTC${now.utcOffset}) · semana ${now.isoWeek} do ano`,
  ];
  if (settings?.computer.enabled === false) {
    lines.push('- Computador: acesso desativado nas Configurações.');
  } else {
    lines.push(...(await describeMachine()));
  }
  lines.push(`- Canal desta conversa: ${mode === 'voice' ? 'voz (a resposta será falada)' : 'texto (chat)'}`);
  if (settings && !settings.hasApiKey) lines.push('- Chave do Gemini: não configurada.');
  return lines.join('\n');
}

// ─── Memórias ────────────────────────────────────────────────────────────

function memoryLine(m: Memory): string {
  const tags = [MEMORY_CATEGORY_LABELS[m.category] ?? m.category, `importância ${m.importance}`];
  if (m.pinned) tags.push('fixada');
  return `- (${tags.join(' · ')}) ${oneLine(m.content, 400)} [id: ${m.id}]`;
}

function coreBlock(core: Memory[]): string {
  if (core.length === 0) {
    return '# PERFIL E MEMÓRIAS ESSENCIAIS\nAinda não há memórias essenciais registradas. Tudo o que você aprender de importante sobre o usuário a partir de agora deve ser guardado.';
  }
  return `# PERFIL E MEMÓRIAS ESSENCIAIS\n${clampLines(core.map(memoryLine), LIMITS.core)}`;
}

function hitLine(hit: MemorySearchHit, tz: string): string {
  const when = shortDateTime(hit.createdAt, tz);
  if (hit.type === 'memory') {
    const label = hit.category ? (MEMORY_CATEGORY_LABELS[hit.category] ?? hit.category) : 'Memória';
    return `- (${label} · registrada em ${when}) ${oneLine(hit.content, 400)} [id: ${hit.id}]`;
  }
  return `- (trecho de conversa de ${when}) ${oneLine(hit.content, 450)}`;
}

async function relevantBlock(
  query: string | undefined,
  conversationId: string,
  exclude: Set<string>,
  tz: string,
): Promise<string | null> {
  const q = query?.trim();
  if (!q) return null;
  const hits = await withTimeout(
    searchMemory(q.slice(0, 2000), {
      limit: RELEVANT_ITEMS + exclude.size,
      includeMessages: true,
      excludeConversationId: conversationId,
    }).catch((error: unknown) => {
      console.warn('[contexto] busca na memória falhou:', error instanceof Error ? error.message : error);
      return [] as MemorySearchHit[];
    }),
    SEARCH_TIMEOUT_MS,
    [] as MemorySearchHit[],
  );
  const items = hits.filter((h) => !(h.type === 'memory' && exclude.has(h.id))).slice(0, RELEVANT_ITEMS);
  if (items.length === 0) return null;
  return `# MEMÓRIAS RELEVANTES PARA ESTA MENSAGEM\n${clampLines(
    items.map((h) => hitLine(h, tz)),
    LIMITS.relevant,
  )}`;
}

// ─── Promessas e lembretes ───────────────────────────────────────────────

function commitmentLine(c: Commitment, tz: string, now: number): string {
  let when: string;
  if (!c.dueAt) when = 'sem prazo';
  else if (new Date(c.dueAt).getTime() < now) when = `⚠ ATRASADA — prazo era ${formatLocalDateTime(c.dueAt, tz)}`;
  else when = `prazo: ${formatLocalDateTime(c.dueAt, tz)}`;
  const extras = [`registrada em ${shortDateTime(c.createdAt, tz)}`];
  if (c.checkCount > 0) {
    extras.push(
      `já cobrada ${c.checkCount}x${c.lastCheckedAt ? ` (última em ${shortDateTime(c.lastCheckedAt, tz)})` : ''}`,
    );
  }
  if (c.notes) extras.push(`nota: ${oneLine(c.notes, 160)}`);
  return `- ${oneLine(c.description, 300)} — ${when} · ${extras.join(' · ')} [id: ${c.id}]`;
}

function commitmentsBlock(tz: string): string {
  let open: Commitment[];
  try {
    open = listCommitments({ status: 'open' });
  } catch (error) {
    console.warn('[contexto] promessas indisponíveis:', error instanceof Error ? error.message : error);
    return '# PROMESSAS ABERTAS\n(indisponível no momento)';
  }
  if (open.length === 0) return '# PROMESSAS ABERTAS\nNenhuma promessa em aberto.';
  const now = Date.now();
  const overdue = open.filter((c) => c.dueAt && new Date(c.dueAt).getTime() < now);
  const rest = open.filter((c) => !overdue.includes(c));
  const ordered = [...overdue, ...rest].slice(0, MAX_COMMITMENTS);
  const header =
    overdue.length > 0
      ? `# PROMESSAS ABERTAS (${open.length}; ${overdue.length} atrasada${overdue.length > 1 ? 's' : ''} — pergunte no momento oportuno)`
      : `# PROMESSAS ABERTAS (${open.length})`;
  const lines = ordered.map((c) => commitmentLine(c, tz, now));
  if (open.length > ordered.length) lines.push(`- (+${open.length - ordered.length} outras; use list_commitments)`);
  return `${header}\n${clampLines(lines, LIMITS.commitments)}`;
}

function reminderLine(r: Reminder, tz: string): string {
  const repeat = r.recurrence !== 'none' ? ` (${RECURRENCE_LABELS[r.recurrence].toLowerCase()})` : '';
  return `- ${formatLocalDateTime(r.dueAt, tz)}${repeat} — ${oneLine(r.text, 200)} [id: ${r.id}]`;
}

function remindersBlock(tz: string): string | null {
  let upcoming: Reminder[];
  try {
    upcoming = listReminders({ status: 'scheduled', to: new Date(Date.now() + REMINDER_HORIZON_MS).toISOString() });
  } catch (error) {
    console.warn('[contexto] lembretes indisponíveis:', error instanceof Error ? error.message : error);
    return null;
  }
  if (upcoming.length === 0) return '# LEMBRETES PRÓXIMOS (48 h)\nNenhum lembrete nas próximas 48 horas.';
  const lines = upcoming.slice(0, MAX_REMINDERS).map((r) => reminderLine(r, tz));
  if (upcoming.length > MAX_REMINDERS) lines.push(`- (+${upcoming.length - MAX_REMINDERS} outros; use list_reminders)`);
  return `# LEMBRETES PRÓXIMOS (48 h)\n${clampLines(lines, LIMITS.reminders)}`;
}

function summaryBlock(conversationId: string): string | null {
  const summary = getConversation(conversationId)?.summary?.trim();
  if (!summary) return null;
  const text = summary.length > LIMITS.summary ? `…${summary.slice(summary.length - LIMITS.summary)}` : summary;
  return `# RESUMO DA CONVERSA ATÉ AQUI (mensagens antigas que não aparecem no histórico)\n${text}`;
}

// ─── API pública ─────────────────────────────────────────────────────────

/**
 * Só os blocos de contexto (sem a persona). Útil para quem monta instruções próprias
 * (ex.: briefing matinal, sessão de voz).
 */
export async function buildContextText(opts: {
  conversationId: string;
  mode: PersonaMode;
  query?: string;
}): Promise<string> {
  const settings = safeSettings();
  const tz = safeTimeZone(settings?.timezone);
  let core: Memory[] = [];
  try {
    core = getCoreMemories(CORE_MEMORIES);
  } catch (error) {
    console.warn('[contexto] memórias essenciais indisponíveis:', error instanceof Error ? error.message : error);
  }
  const [now, relevant] = await Promise.all([
    nowBlock(settings, opts.mode),
    relevantBlock(opts.query, opts.conversationId, new Set(core.map((m) => m.id)), tz),
  ]);
  const blocks = [
    now,
    coreBlock(core),
    relevant,
    commitmentsBlock(tz),
    remindersBlock(tz),
    summaryBlock(opts.conversationId),
  ];
  return blocks.filter((b): b is string => Boolean(b)).join('\n\n');
}

/**
 * Instrução de sistema completa do turno: persona + contexto atual.
 * `query` (normalmente a mensagem do usuário) guia a busca de memórias relevantes.
 */
export async function buildSystemInstruction(opts: {
  conversationId: string;
  mode: 'text' | 'voice';
  query?: string;
}): Promise<string> {
  const settings = getSettings();
  const persona = buildPersona(settings, opts.mode);
  const context = await buildContextText(opts);
  return `${persona}\n\n═══════ CONTEXTO ATUAL (gerado automaticamente a cada mensagem — confie nele) ═══════\n\n${context}`;
}

/** Texto de uma mensagem como o Gemini deve vê-la no histórico (com notas internas das ações). */
function historyText(m: ChatMessage): string {
  const content = (m.content ?? '').trim();
  if (m.role === 'system') return content ? `⟦nota do sistema: ${content}⟧` : '';
  if (m.role === 'user') return content;

  const notes: string[] = [];
  if (m.kind === 'proactive' || m.kind === 'briefing') {
    notes.push(m.kind === 'briefing' ? '⟦briefing enviado por iniciativa própria⟧' : '⟦mensagem enviada por iniciativa própria⟧');
  }
  const calls = (m.toolCalls ?? []).filter((c) => c.status !== 'running' && c.status !== 'awaiting_approval');
  if (calls.length > 0) {
    const described = calls
      .slice(0, 12)
      .map((c) => {
        const status = c.status === 'done' ? '' : c.status === 'denied' ? ' (negada)' : ' (falhou)';
        return `${c.name}${status}${c.summary ? `: ${oneLine(c.summary, 140)}` : ''}`;
      })
      .join('; ');
    notes.push(`⟦ações executadas neste turno — ${described}⟧`);
  }
  return [notes.join(' '), content].filter(Boolean).join('\n');
}

/**
 * Converte mensagens salvas em histórico do Gemini: 'user'/'system' → user, 'assistant' → model
 * (inclusive mensagens proativas e briefings). Junta mensagens consecutivas do mesmo papel em um
 * único Content (uma parte por mensagem), omite as vazias e garante que o histórico comece pelo usuário.
 */
export function toGeminiHistory(messages: ChatMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    const text = historyText(m);
    if (!text) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts!.push({ text });
    else out.push({ role, parts: [{ text }] });
  }
  if (out.length > 0 && out[0].role === 'model') out.unshift({ role: 'user', parts: [{ text: CONVERSATION_START_NOTE }] });
  return out;
}
