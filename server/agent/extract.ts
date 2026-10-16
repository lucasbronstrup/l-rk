/**
 * Extração automática (pós-turno) de memórias e promessas a partir da última troca da conversa.
 *
 * Um modelo rápido lê a mensagem do usuário + a resposta do Lärk, as memórias parecidas já
 * existentes e as promessas pendentes, e devolve JSON com:
 *   memories · memory_updates · commitments · commitment_updates
 * O resultado é validado (zod) e aplicado com deduplicação — inclusive contra o que o próprio
 * modelo já registrou por ferramenta no mesmo turno.
 */
import { z } from 'zod';
import { generateText } from '../llm/gemini.js';
import { getSettings } from '../memory/settings.js';
import { listMessages } from '../memory/messages.js';
import { MEMORY_CATEGORIES, createMemory, getMemory, isMemoryCategory, listMemories, updateMemory } from '../memory/memories.js';
import { findSimilarMemories, findSimilarMemoriesScored, isNearDuplicate } from '../memory/search.js';
import { createCommitment, getCommitment, listCommitments, updateCommitment } from '../memory/commitments.js';
import { formatLocalDateTime, parseOptionalUserDate, safeTimeZone } from '../memory/time.js';
import { lexicalSimilarity, truncateText } from '../memory/text.js';
import { describeNow } from '../tools/utility.js';
import type { ChatMessage, Memory, MemoryCategory, ToolCallInfo } from '../../shared/types.js';

const MAX_NEW_MEMORIES = 6;
const MAX_NEW_COMMITMENTS = 3;
const MAX_UPDATES = 6;
const MAX_EXCHANGE_CHARS = 6_000;
/** Similaridade lexical a partir da qual dois textos são considerados o mesmo registro. */
const SAME_TEXT = 0.6;

/** Última resposta já analisada por conversa (evita extrair duas vezes a mesma troca). */
const lastExtracted = new Map<string, string>();

const TRIVIAL_RE =
  /^(ok(ay)?|tá|ta|blz|beleza|valeu|vlw|obrigad[oa]|brigad[oa]|sim|não|nao|isso|certo|show|top|perfeito|legal|kk+|ha(ha)+|rs+|oi|olá|ola|e aí|bom dia|boa tarde|boa noite|tchau|até mais|falou|entendi|uhum|hm+)[\s!.,?]*$/iu;

// ─── Esquema da resposta ─────────────────────────────────────────────────

const importance = z.coerce
  .number()
  .catch(3)
  .transform((n) => Math.min(5, Math.max(1, Math.round(Number.isFinite(n) ? n : 3))));

const memoryItemSchema = z.object({
  content: z.string().trim().min(3).max(1000),
  category: z
    .string()
    .optional()
    .transform((v): MemoryCategory => {
      const c = (v ?? '').trim().toLowerCase();
      return isMemoryCategory(c) ? c : 'other';
    }),
  importance: importance.optional().transform((n) => n ?? 3),
});

const memoryUpdateSchema = z.object({
  id: z.string().trim().min(1),
  content: z.string().trim().min(3).max(1000),
});

const commitmentItemSchema = z.object({
  description: z.string().trim().min(3).max(1000),
  due_at: z.string().trim().nullish().catch(null),
});

const commitmentUpdateSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(['done', 'missed', 'cancelled']),
  note: z.string().trim().max(1000).nullish().catch(null),
});

export interface ExtractionResult {
  memories: z.infer<typeof memoryItemSchema>[];
  memory_updates: z.infer<typeof memoryUpdateSchema>[];
  commitments: z.infer<typeof commitmentItemSchema>[];
  commitment_updates: z.infer<typeof commitmentUpdateSchema>[];
}

/** Valida cada item isoladamente: itens inválidos são descartados sem perder os demais. */
function parseList<T extends z.ZodType>(value: unknown, schema: T, max: number): z.infer<T>[] {
  if (!Array.isArray(value)) return [];
  const out: z.infer<T>[] = [];
  for (const item of value) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    if (out.length >= max) break;
  }
  return out;
}

/** Interpreta a resposta do modelo (tolerante a cercas de código e texto ao redor). */
export function parseExtraction(raw: string): ExtractionResult {
  const empty: ExtractionResult = { memories: [], memory_updates: [], commitments: [], commitment_updates: [] };
  const text = String(raw ?? '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  const obj = z.record(z.string(), z.unknown()).safeParse(data);
  if (!obj.success) return empty;
  const d = obj.data;
  return {
    memories: parseList(d.memories, memoryItemSchema, MAX_NEW_MEMORIES),
    memory_updates: parseList(d.memory_updates, memoryUpdateSchema, MAX_UPDATES),
    commitments: parseList(d.commitments, commitmentItemSchema, MAX_NEW_COMMITMENTS),
    commitment_updates: parseList(d.commitment_updates, commitmentUpdateSchema, MAX_UPDATES),
  };
}

// ─── Coleta da troca e do contexto ───────────────────────────────────────

interface Exchange {
  user: ChatMessage[];
  assistant: ChatMessage;
}

/** Última troca: a resposta mais recente do Lärk (chat/voz) e as falas do usuário logo antes dela. */
export function findLastExchange(messages: ChatMessage[]): Exchange | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (m.kind === 'proactive' || m.kind === 'briefing') return null;
    const user: ChatMessage[] = [];
    for (let j = i - 1; j >= 0 && messages[j].role === 'user'; j--) user.unshift(messages[j]);
    return user.length > 0 ? { user, assistant: m } : null;
  }
  return null;
}

/** Registros que o modelo já fez por ferramenta neste turno (para não duplicar). */
interface ToolRecords {
  memoryTexts: string[];
  memoryIds: Set<string>;
  commitmentTexts: string[];
  commitmentIds: Set<string>;
}

function argString(call: ToolCallInfo, key: string): string {
  const v = call.args?.[key];
  return typeof v === 'string' ? v : '';
}

function collectToolRecords(calls: ToolCallInfo[] | undefined): ToolRecords {
  const records: ToolRecords = { memoryTexts: [], memoryIds: new Set(), commitmentTexts: [], commitmentIds: new Set() };
  for (const call of calls ?? []) {
    if (call.status !== 'done') continue;
    if (call.name === 'remember') records.memoryTexts.push(argString(call, 'content'));
    if (call.name === 'update_memory' || call.name === 'forget') {
      records.memoryIds.add(argString(call, 'id'));
      if (argString(call, 'content')) records.memoryTexts.push(argString(call, 'content'));
    }
    if (call.name === 'create_commitment') records.commitmentTexts.push(argString(call, 'description'));
    if (call.name === 'update_commitment') records.commitmentIds.add(argString(call, 'id'));
  }
  return records;
}

function describeToolRecords(calls: ToolCallInfo[] | undefined): string[] {
  return (calls ?? [])
    .filter((c) => c.status === 'done' && /^(remember|update_memory|forget|create_commitment|update_commitment)$/.test(c.name))
    .map((c) => `- ${c.name}: ${truncateText(c.summary ?? JSON.stringify(c.args), 200)}`);
}

async function relatedMemories(text: string): Promise<Memory[]> {
  const byId = new Map<string, Memory>();
  try {
    for (const m of listMemories({ q: text.slice(0, 500), limit: 10 }).items) byId.set(m.id, m);
  } catch {
    // Busca textual indisponível: segue com a semântica.
  }
  try {
    for (const m of await findSimilarMemories(text.slice(0, 2000), 6)) byId.set(m.id, m);
  } catch {
    // Embeddings indisponíveis.
  }
  return [...byId.values()].slice(0, 14);
}

// ─── Prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é o módulo de memória do Lärk, um assistente pessoal. Analise a troca mais recente entre o usuário e o Lärk e extraia apenas o que vale guardar para sempre. Responda SOMENTE com JSON válido, sem comentários, neste formato:
{
  "memories": [{"content": "frase autocontida em terceira pessoa", "category": "${MEMORY_CATEGORIES.join('|')}", "importance": 1-5}],
  "memory_updates": [{"id": "id de uma memória existente", "content": "texto completo corrigido"}],
  "commitments": [{"description": "o que o usuário prometeu fazer", "due_at": "ISO-8601 com offset ou null"}],
  "commitment_updates": [{"id": "id de uma promessa pendente", "status": "done|missed|cancelled", "note": "como foi, em poucas palavras"}]
}

Regras:
- memories: só fatos DURADOUROS e úteis sobre o usuário e a vida dele (identidade, preferências, pessoas próximas e seus nomes, objetivos, rotina, projetos, trabalho, estudos, saúde, conquistas, datas importantes). Nada efêmero ("está com sono agora"), nada sobre o próprio Lärk, nada de conhecimento geral. Escreva em português, em terceira pessoa, com o nome do usuário quando conhecido (ex.: "Lucas toca violino na orquestra da cidade"). Importância: 5 = identidade/saúde/pessoas muito próximas; 4 = objetivos e fatos centrais; 3 = preferências e contexto útil; 2 = detalhe menor.
- Não repita o que já está nas MEMÓRIAS EXISTENTES nem o que o Lärk JÁ REGISTROU neste turno. Se um fato existente mudou ou estava errado, use memory_updates com o id dele (nunca invente ids).
- commitments: só ações FUTURAS que o USUÁRIO disse que vai fazer ("vou", "prometo", "preciso", "tenho que", "amanhã eu…"). Não registre tarefas do Lärk nem desejos vagos. Calcule due_at a partir de AGORA (só a data → use 23:59 daquele dia; sem prazo inferível → null).
- commitment_updates: só quando o usuário disser claramente que cumpriu (done), que não cumpriu (missed) ou que desistiu (cancelled) de uma das PROMESSAS PENDENTES listadas, usando o id exato.
- Conversa trivial ou sem nada novo → todas as listas vazias. Na dúvida, não registre.`;

function formatExchange(exchange: Exchange): string {
  const userText = exchange.user.map((m) => m.content.trim()).filter(Boolean).join('\n');
  const assistantText = exchange.assistant.content.trim();
  const half = Math.floor(MAX_EXCHANGE_CHARS / 2);
  return `Usuário: ${truncateText(userText, half)}\nLärk: ${truncateText(assistantText, half)}`;
}

// ─── Aplicação ───────────────────────────────────────────────────────────

export interface ExtractionSummary {
  memoriesCreated: number;
  memoriesUpdated: number;
  commitmentsCreated: number;
  commitmentsUpdated: number;
}

const cleanText = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Aplica o resultado da extração com deduplicação.
 * @param toolCalls chamadas de ferramenta do turno (o que o modelo já registrou não é repetido).
 */
export async function applyExtraction(result: ExtractionResult, toolCalls?: ToolCallInfo[]): Promise<ExtractionSummary> {
  const summary: ExtractionSummary = { memoriesCreated: 0, memoriesUpdated: 0, commitmentsCreated: 0, commitmentsUpdated: 0 };
  const records = collectToolRecords(toolCalls);
  const tz = safeTimeZone(getSettings().timezone);

  for (const item of result.memories) {
    const content = cleanText(item.content);
    if (content.length < 8 || item.importance < 2) continue;
    if (records.memoryTexts.some((t) => t && lexicalSimilarity(t, content) >= SAME_TEXT)) continue;
    try {
      const duplicate = (await findSimilarMemoriesScored(content, 5)).find(isNearDuplicate);
      if (duplicate) {
        if (item.importance > duplicate.memory.importance) {
          updateMemory(duplicate.memory.id, { importance: item.importance });
          summary.memoriesUpdated++;
        }
        continue;
      }
      createMemory({ content, category: item.category, importance: item.importance, source: 'auto' });
      records.memoryTexts.push(content);
      summary.memoriesCreated++;
    } catch (error) {
      console.warn('[extração] memória descartada:', error instanceof Error ? error.message : error);
    }
  }

  for (const item of result.memory_updates) {
    if (records.memoryIds.has(item.id)) continue;
    const current = getMemory(item.id);
    const content = cleanText(item.content);
    if (!current || content === current.content) continue;
    try {
      updateMemory(item.id, { content });
      records.memoryIds.add(item.id);
      summary.memoriesUpdated++;
    } catch (error) {
      console.warn('[extração] atualização de memória descartada:', error instanceof Error ? error.message : error);
    }
  }

  const open = listCommitments({ status: 'open' });
  for (const item of result.commitments) {
    const description = cleanText(item.description);
    if (description.length < 4) continue;
    const similar = (t: string) => t && lexicalSimilarity(t, description) >= SAME_TEXT;
    if (open.some((c) => similar(c.description)) || records.commitmentTexts.some(similar)) continue;
    let dueAt: string | null = null;
    try {
      dueAt = parseOptionalUserDate(item.due_at ?? null, { timeZone: tz, dateOnlyTime: '23:59' });
    } catch {
      dueAt = null;
    }
    // Prazo no passado é quase sempre erro de cálculo do modelo: registra sem prazo.
    if (dueAt && new Date(dueAt).getTime() < Date.now() - 60 * 60_000) dueAt = null;
    try {
      const created = createCommitment({ description, dueAt, notes: 'Registrada automaticamente a partir da conversa.' });
      open.push(created);
      summary.commitmentsCreated++;
    } catch (error) {
      console.warn('[extração] promessa descartada:', error instanceof Error ? error.message : error);
    }
  }

  for (const item of result.commitment_updates) {
    if (records.commitmentIds.has(item.id)) continue;
    const current = getCommitment(item.id);
    if (!current || current.status !== 'pending') continue;
    const note = item.note ? cleanText(item.note) : '';
    try {
      updateCommitment(item.id, {
        status: item.status,
        ...(note ? { notes: current.notes ? `${current.notes}\n${note}` : note } : {}),
      });
      records.commitmentIds.add(item.id);
      summary.commitmentsUpdated++;
    } catch (error) {
      console.warn('[extração] atualização de promessa descartada:', error instanceof Error ? error.message : error);
    }
  }
  return summary;
}

// ─── API pública ─────────────────────────────────────────────────────────

/**
 * Analisa a última troca da conversa e registra memórias/promessas novas.
 * Devolve null quando não havia nada a analisar (troca já processada, trivial ou inexistente).
 */
export async function extractFromLastExchange(conversationId: string): Promise<ExtractionSummary | null> {
  const exchange = findLastExchange(listMessages(conversationId, { limit: 12 }));
  if (!exchange) return null;
  if (lastExtracted.get(conversationId) === exchange.assistant.id) return null;
  lastExtracted.set(conversationId, exchange.assistant.id);

  const userText = exchange.user.map((m) => m.content).join('\n').trim();
  if (userText.length < 4 || TRIVIAL_RE.test(userText)) return null;

  const settings = getSettings();
  const tz = safeTimeZone(settings.timezone);
  const now = describeNow(tz);
  const memories = await relatedMemories(userText);
  const pending = listCommitments({ status: 'open' }).slice(0, 20);
  const alreadyDone = describeToolRecords(exchange.assistant.toolCalls);

  const prompt = [
    `AGORA: ${now.local} · ISO ${now.iso} · fuso ${now.timezone}`,
    `NOME DO USUÁRIO: ${settings.userName.trim() || 'não informado'}`,
    '',
    'MEMÓRIAS EXISTENTES (relacionadas):',
    memories.length
      ? memories.map((m) => `- [${m.id}] (${m.category}, importância ${m.importance}) ${truncateText(m.content, 300)}`).join('\n')
      : '- (nenhuma)',
    '',
    'PROMESSAS PENDENTES:',
    pending.length
      ? pending
          .map((c) => `- [${c.id}] ${truncateText(c.description, 200)}${c.dueAt ? ` (prazo: ${formatLocalDateTime(c.dueAt, tz)})` : ''}`)
          .join('\n')
      : '- (nenhuma)',
    '',
    'JÁ REGISTRADO PELO LÄRK NESTE TURNO:',
    alreadyDone.length ? alreadyDone.join('\n') : '- (nada)',
    '',
    'TROCA MAIS RECENTE:',
    formatExchange(exchange),
  ].join('\n');

  const raw = await generateText({
    role: 'fast',
    json: true,
    system: SYSTEM_PROMPT,
    prompt,
    temperature: 0.2,
    maxOutputTokens: 2048,
    timeoutMs: 45_000,
  });
  return applyExtraction(parseExtraction(raw), exchange.assistant.toolCalls);
}

/** Esquece qual foi a última troca analisada (testes). */
export function resetExtractionState(): void {
  lastExtracted.clear();
}
