/**
 * Modo demonstração do Lärk: respostas simuladas, sem chamar o Gemini.
 *
 * Usado quando `LARK_MOCK=1` (ou `config.mock`). Simula um streaming realista (pensamento curto +
 * resposta em pedaços, no estilo do Lärk) e aciona ferramentas REAIS simples a partir de
 * palavras-chave, para testar o sistema de ponta a ponta sem chave:
 *   "meu nome é X" → remember · "lembre-se que …" → remember · "lembra de mim?" → recall
 *   "me lembra de …" / "lembrete" → create_reminder (+1 h) · "prometo …" / "vou …" → create_commitment
 *   "computador" / "sistema" → system_status
 */
import { runTool } from '../tools/index.js';
import { getSettings } from '../memory/settings.js';
import { addCalendarDays, safeTimeZone, toWallClock } from '../memory/time.js';
import { describeNow } from '../tools/utility.js';
import type { ToolCallInfo } from '../../shared/types.js';

/** Nome exibido como "modelo" no modo demonstração. */
export const MOCK_MODEL = 'lark-demonstracao';

const DEFAULT_TOKEN_DELAY_MS = 22;
const THOUGHT_DELAY_MS = 120;

export interface MockAction {
  name: string;
  args: Record<string, unknown>;
}

export interface MockTurnOptions {
  conversationId: string;
  userText: string;
  mode: 'text' | 'voice';
  onThought: (text: string) => void;
  onToken: (text: string) => void;
  onTool: (call: ToolCallInfo) => void;
  signal?: AbortSignal;
  /** Intervalo entre pedaços de texto (padrão ~22 ms). */
  tokenDelayMs?: number;
  /** Instante de referência (testes). */
  now?: Date;
}

// ─── Utilidades ──────────────────────────────────────────────────────────

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Geração interrompida.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(abortError(signal)) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const capitalize = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1) : s);
const cleanClause = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s,;:.!?…]+$/u, '');

function userTimeZone(): string {
  try {
    return safeTimeZone(getSettings().timezone);
  } catch {
    return safeTimeZone(undefined);
  }
}

/** "AAAA-MM-DDT23:59:00" (sem offset: interpretado no fuso do usuário pela ferramenta). */
function localEndOfDay(now: Date, tz: string, plusDays: number): string {
  const w = toWallClock(now, tz);
  const d = addCalendarDays(w.year, w.month, w.day, plusDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.year}-${pad(d.month)}-${pad(d.day)}T23:59:00`;
}

// ─── Detecção de intenções ───────────────────────────────────────────────

const NAME_RE = /(?:^|[^\p{L}])(?:meu nome (?:é|e)|me chamo|pode me chamar de|me chame de)\s+(.+)/iu;
/** Primeiro nome (qualquer caixa) e, opcionalmente, um sobrenome com inicial maiúscula. Sem flag `i` de propósito. */
const NAME_WORDS_RE = /^([\p{L}][\p{L}'’-]*)(?:\s+(\p{Lu}[\p{L}'’-]*))?/u;
const REMEMBER_RE = /\b(?:lembre-se|lembra|guarde|anote|grave|memorize)\s+(?:de\s+|disso:\s*)?que\s+(.+)/iu;
const RECALL_RE = /\b(?:lembra de mim|você (?:se )?lembra|vc lembra|o que você sabe sobre mim)\b/iu;
const REMINDER_RE =
  /\b(?:me lembr[ae]|lembre-me|me avis[ae]|avise-me|cri[ae] um lembrete|lembrete)\b\s*(?:de|para|pra|que|sobre|:)?\s*(.*)/iu;
const COMMITMENT_RE = /\b(?:prometo(?:\s+que)?|vou|preciso|tenho que)\s+(.+)/iu;
const GREETING_RE = /^\s*(?:oi|olá|ola|e a[ií]|eae|bom dia|boa tarde|boa noite|hey|salve)(?!\p{L})/iu;
const SYSTEM_RE = /\b(?:computador|sistema|máquina|maquina|cpu|processador|desempenho)\b/iu;

/**
 * Ações de ferramentas que o modo demonstração executa para a mensagem (no máximo três).
 * Função pura, exportada para testes.
 */
export function planMockActions(userText: string, now: Date = new Date(), tz: string = userTimeZone()): MockAction[] {
  const text = userText.replace(/\s+/g, ' ').trim();
  const actions: MockAction[] = [];

  const name = NAME_WORDS_RE.exec(NAME_RE.exec(text)?.[1] ?? '');
  if (name) {
    const value = [name[1], name[2]].filter(Boolean).map(capitalize).join(' ');
    actions.push({
      name: 'remember',
      args: { content: `O usuário prefere ser chamado de ${value}`, category: 'person', importance: 5 },
    });
  }

  const fact = REMEMBER_RE.exec(text);
  if (fact && cleanClause(fact[1])) {
    actions.push({ name: 'remember', args: { content: capitalize(cleanClause(fact[1])), category: 'fact', importance: 3 } });
  } else if (RECALL_RE.test(text)) {
    actions.push({ name: 'recall', args: { query: text } });
  }

  const reminder = !fact ? REMINDER_RE.exec(text) : null;
  if (reminder) {
    const what = capitalize(cleanClause(reminder[1] || '')) || 'Lembrete pedido na conversa';
    const due = new Date(now.getTime() + 60 * 60_000);
    actions.push({ name: 'create_reminder', args: { text: what, due_at: describeNow(tz, due).iso, recurrence: 'none' } });
  } else {
    const promise = text.includes('?') ? null : COMMITMENT_RE.exec(text);
    if (promise && cleanClause(promise[1]).length >= 3 && !/^(de|da|do|das|dos|que você|você)\b/iu.test(promise[1])) {
      const clause = cleanClause(promise[1]);
      const dueAt = /\bamanh[ãa](?!\p{L})/iu.test(clause)
        ? localEndOfDay(now, tz, 1)
        : /\bhoje\b/iu.test(clause)
          ? localEndOfDay(now, tz, 0)
          : null;
      actions.push({
        name: 'create_commitment',
        args: { description: capitalize(clause), ...(dueAt ? { due_at: dueAt } : {}) },
      });
    }
  }

  if (SYSTEM_RE.test(text)) actions.push({ name: 'system_status', args: {} });
  return actions.slice(0, 3);
}

// ─── Composição da resposta ──────────────────────────────────────────────

const REFLECTIONS = {
  reminder: 'Agenda não é prisão: é a forma mais elegante de libertar a mente para o que importa agora.',
  commitment: 'Medo é o ingresso — e a promessa que você diz em voz alta já começou a ser cumprida.',
  memory: 'Como escreveu Oscar Wilde, a memória é o diário que todos carregamos conosco. O seu agora tem um guardião.',
  system: 'Quem cuida da máquina cuida do tempo — e tempo é o único recurso que não se reinstala.',
  greeting: 'Toda grande conversa começa com uma pergunta bem feita. A próxima é sua.',
  generic: 'Sêneca já avisava: enquanto adiamos, a vida passa. Então vamos ao que interessa.',
} as const;

function sentenceFor(call: ToolCallInfo): string {
  const summary = (call.summary ?? '').trim();
  if (call.status === 'denied') return `Eu ia ${call.label.toLowerCase()}, mas a ação foi negada — e quem manda aqui é você.`;
  if (call.status !== 'done') return `Tentei uma ação (${call.label.toLowerCase()}), mas ela falhou: ${summary || 'motivo desconhecido'}.`;
  switch (call.name) {
    case 'create_reminder':
      return `${summary}. Daqui a uma hora, eu te chamo.`;
    case 'create_commitment':
      return `${summary}. E eu vou cobrar — com carinho, mas vou.`;
    case 'remember':
      return `${summary}. Esse tipo de detalhe não se perde comigo.`;
    case 'recall':
      return `Consultei a memória: ${summary.charAt(0).toLocaleLowerCase('pt-BR')}${summary.slice(1)}.`;
    case 'system_status':
      return `Diagnóstico da máquina: ${summary}.`;
    default:
      return `${call.label}: ${summary}.`;
  }
}

function composeReply(userText: string, calls: ToolCallInfo[], mode: 'text' | 'voice'): string {
  const voice = mode === 'voice';
  const paragraphs: string[] = [];
  const names = new Set(calls.filter((c) => c.status === 'done').map((c) => c.name));

  if (calls.length > 0) {
    paragraphs.push(calls.map(sentenceFor).join(' '));
  } else if (GREETING_RE.test(userText)) {
    paragraphs.push(
      'Olá. Sistemas no ar, memória ativa e atenção total em você. Estou em modo demonstração: sem a chave do Google AI Studio, meu raciocínio completo fica em pausa — mas lembretes, promessas e memória já funcionam de verdade.',
    );
  } else {
    const excerpt = cleanClause(userText).slice(0, 140);
    paragraphs.push(
      `Recebi a sua mensagem${excerpt ? ` — "${excerpt}${userText.length > 140 ? '…' : ''}"` : ''}. Estou em modo demonstração, então respondo com o que já sei fazer sem a chave do Gemini: guardar o que importa, agendar lembretes e cobrar promessas.`,
    );
  }

  const reflection = names.has('create_commitment')
    ? REFLECTIONS.commitment
    : names.has('create_reminder')
      ? REFLECTIONS.reminder
      : names.has('remember') || names.has('recall')
        ? REFLECTIONS.memory
        : names.has('system_status')
          ? REFLECTIONS.system
          : calls.length === 0 && GREETING_RE.test(userText)
            ? REFLECTIONS.greeting
            : REFLECTIONS.generic;
  paragraphs.push(reflection);

  if (calls.length === 0) {
    paragraphs.push(
      voice
        ? 'Quando quiser a versão completa, cole a sua chave gratuita nas Configurações. Bora?'
        : '_Modo demonstração — cole a chave gratuita do Google AI Studio em **Configurações** para eu pensar de verdade._',
    );
  }
  return paragraphs.join(voice ? ' ' : '\n\n');
}

/** Divide o texto em pedaços de 1–3 palavras, preservando os espaços (simula tokens). */
function chunkText(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; ) {
    const size = 1 + ((i * 7 + words.length) % 3);
    chunks.push(words.slice(i, i + size).join(''));
    i += size;
  }
  return chunks;
}

// ─── Turno simulado ──────────────────────────────────────────────────────

/**
 * Executa um turno simulado. Emite pensamento, chamadas de ferramenta (reais) e tokens.
 * @throws o motivo do cancelamento (AbortError) quando `signal` é abortado — o texto já emitido
 *         fica com quem chamou.
 */
export async function runMockTurn(opts: MockTurnOptions): Promise<void> {
  const delay = Math.max(0, opts.tokenDelayMs ?? DEFAULT_TOKEN_DELAY_MS);
  const signal = opts.signal;
  const actions = planMockActions(opts.userText, opts.now ?? new Date());

  const intents = actions.length > 0 ? actions.map((a) => a.name).join(', ') : 'conversa';
  opts.onThought('Modo demonstração: lendo a intenção da mensagem');
  await sleep(Math.min(delay * 3, THOUGHT_DELAY_MS), signal);
  opts.onThought(` — ${intents}. Resposta simulada, ferramentas reais.`);
  await sleep(Math.min(delay * 3, THOUGHT_DELAY_MS), signal);

  const calls: ToolCallInfo[] = [];
  for (const action of actions) {
    if (signal?.aborted) throw abortError(signal);
    const { call } = await runTool(action.name, action.args, {
      conversationId: opts.conversationId,
      mode: opts.mode,
      emit: opts.onTool,
      signal,
    });
    calls.push(call);
  }

  for (const chunk of chunkText(composeReply(opts.userText, calls, opts.mode))) {
    if (signal?.aborted) throw abortError(signal);
    opts.onToken(chunk);
    await sleep(delay, signal);
  }
}
