/**
 * Ferramentas utilitárias (data/hora, calculadora, conversão de unidades) e utilidades
 * compartilhadas pelas demais ferramentas do computador (validação de argumentos, formatação,
 * cancelamento).
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { getSettings } from '../memory/settings.js';
import { formatLocalDateTime, safeTimeZone, toWallClock } from '../memory/time.js';
import type { ToolRisk } from '../../shared/types.js';
import type { ToolDefinition } from './types.js';

// ─── Tipos e utilidades compartilhadas ───────────────────────────────────

/** Grupo de uma ferramenta: 'computer' some quando o acesso ao computador está desligado. */
export type ToolGroup = 'computer' | 'web' | 'utility';

/**
 * ToolDefinition com metadados extras usados por `runTool`:
 * risco dinâmico (ex.: sobrescrever é mais grave que criar) e timeout próprio.
 */
export type ToolSpec = ToolDefinition<Record<string, unknown>> & {
  group: ToolGroup;
  /** Risco efetivo para estes argumentos (padrão: `risk`). Nunca deve lançar exceção. */
  riskFor?: (args: Record<string, unknown>) => ToolRisk;
  /** Tempo máximo de execução em ms (padrão 60 s). */
  timeoutMs?: number | ((args: Record<string, unknown>) => number);
};

/** Valida argumentos vindos do modelo com uma mensagem clara em PT-BR. */
export function parseArgs<T extends z.ZodType>(tool: string, schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'argumentos'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Argumentos inválidos para ${tool} — ${details}`);
}

/** Texto obrigatório (aparado, não vazio). */
export const requiredText = (label: string) =>
  z.string({ error: `informe ${label}` }).trim().min(1, `informe ${label}`);

/** Inteiro opcional com limites (aceita "10" como 10). */
export const optionalInt = (min: number, max: number) =>
  z.coerce
    .number({ error: `use um número entre ${min} e ${max}` })
    .transform((n) => Math.round(n))
    .pipe(z.number().min(min, `mínimo ${min}`).max(max, `máximo ${max}`))
    .nullish();

/** Booleano opcional tolerante ("true"/"false" vindos como texto). */
export const optionalBool = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
  .nullish();

/** Lê uma string de args sem validar (para describe/riskFor, que não podem falhar). */
export function argText(args: Record<string, unknown>, key: string): string {
  const v = args?.[key];
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v);
}

/** Tamanho legível em PT-BR (ex.: "1,5 MB"). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${units[i]}`;
}

/** Corta um texto longo mantendo início e fim, com aviso no meio. */
export function clipMiddle(text: string, max: number): { text: string; truncated: boolean; omitted: number } {
  if (text.length <= max) return { text, truncated: false, omitted: 0 };
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[… ${omitted.toLocaleString('pt-BR')} caracteres omitidos …]\n\n${text.slice(text.length - tail)}`,
    truncated: true,
    omitted,
  };
}

/** Plural simples: plural(3, 'arquivo', 'arquivos') → "3 arquivos". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
}

const shortFormatters = new Map<string, Intl.DateTimeFormat>();

/** Data/hora curta no fuso do usuário (ex.: "16/10/2026 14:03"). */
export function shortDateTime(date: Date | number | string, timeZone = userTimeZone()): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  let fmt = shortFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' });
    shortFormatters.set(timeZone, fmt);
  }
  return fmt.format(d);
}

/** Fuso das configurações (com fallback seguro). */
export function userTimeZone(): string {
  try {
    return safeTimeZone(getSettings().timezone);
  } catch {
    return safeTimeZone(undefined);
  }
}

/** Erro de cancelamento padronizado. */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('A ação foi cancelada.', 'AbortError');
}

/** Lança se o sinal já foi abortado. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Combina um sinal opcional com um timeout. */
export function withTimeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ─── Data e hora ─────────────────────────────────────────────────────────

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function isoWeek(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

function utcOffset(date: Date, timeZone: string): string {
  const w = toWallClock(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const minutes = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Descrição completa do instante atual no fuso indicado (usada pela ferramenta e por outros módulos). */
export function describeNow(timeZone = userTimeZone(), now = new Date()) {
  const tz = safeTimeZone(timeZone);
  const w = toWallClock(now, tz);
  const weekday = WEEKDAYS[new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()];
  const startOfYear = Date.UTC(w.year, 0, 1);
  const dayOfYear = Math.floor((Date.UTC(w.year, w.month - 1, w.day) - startOfYear) / 86_400_000) + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = utcOffset(now, tz);
  const hour = w.hour;
  const period = hour < 5 ? 'madrugada' : hour < 12 ? 'manhã' : hour < 18 ? 'tarde' : 'noite';
  return {
    iso: `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offset}`,
    utc: now.toISOString(),
    local: formatLocalDateTime(now.toISOString(), tz),
    date: `${pad(w.day)}/${pad(w.month)}/${w.year}`,
    time: `${pad(w.hour)}:${pad(w.minute)}`,
    weekday,
    period,
    timezone: tz,
    utcOffset: offset,
    dayOfYear,
    isoWeek: isoWeek(w.year, w.month, w.day),
    unixSeconds: Math.floor(now.getTime() / 1000),
  };
}

const getDatetime: ToolSpec = {
  name: 'get_datetime',
  label: 'Consultando o relógio',
  group: 'utility',
  risk: 'safe',
  description:
    'Informa a data e a hora atuais exatas (dia da semana, período do dia, fuso, semana do ano). ' +
    'Use antes de calcular prazos, agendar lembretes ou responder "que dia é hoje?"/"que horas são?". ' +
    'Aceita opcionalmente outro fuso IANA para saber a hora em outra cidade (ex.: "Europe/Lisbon", "Asia/Tokyo").',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'Fuso IANA opcional (ex.: "America/New_York"). Padrão: o fuso do usuário.',
      },
    },
  },
  async execute(args) {
    const a = parseArgs('get_datetime', z.object({ timezone: z.string().trim().nullish() }), args);
    const requested = a.timezone || userTimeZone();
    const tz = safeTimeZone(requested);
    const info = describeNow(tz);
    return {
      output: {
        ...info,
        ...(a.timezone && tz !== a.timezone ? { note: `Fuso "${a.timezone}" inválido; usei ${tz}.` } : {}),
      },
      summary: `${info.weekday}, ${info.date} · ${info.time} (${tz})`,
    };
  },
};

// ─── Calculadora (mathjs isolado em worker) ─────────────────────────────

type MathTask =
  | { kind: 'evaluate'; expression: string }
  | { kind: 'convert'; value: number; from: string; to: string };

interface MathResult {
  result: string;
  type: string;
  value: number | null;
}

/**
 * Código do worker: carrega o mathjs, desativa funções que permitiriam escapar do escopo
 * matemático e responde a pedidos { id, task }. Isolado em thread própria para que uma expressão
 * patológica (laço exponencial, matriz gigante) não trave o servidor — o worker é encerrado no timeout.
 */
const MATH_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { create, all } = require(workerData.mathjsPath);
const math = create(all);
const evaluate = math.evaluate;
const unit = math.unit;
// Instancia antes de bloquear 'parse' (elas o usam internamente).
void math.derivative; void math.simplify; void math.rationalize;
const disabled = (name) => function () { throw new Error('A função ' + name + ' está desativada por segurança.'); };
math.import({
  import: disabled('import'),
  createUnit: disabled('createUnit'),
  evaluate: disabled('evaluate'),
  parse: disabled('parse'),
  compile: disabled('compile'),
  reviver: disabled('reviver'),
  resolve: disabled('resolve'),
}, { override: true });

function describe(value) {
  const type = math.typeOf(value);
  if (typeof value === 'number') {
    const text = Number.isInteger(value) && Math.abs(value) < 1e21 ? String(value) : math.format(value, { precision: 15 });
    return { result: text, type, value: Number.isFinite(value) ? value : null };
  }
  if (typeof value === 'function') throw new Error('Definir funções não é permitido aqui; escreva a expressão diretamente.');
  if (value && value.entries && type === 'ResultSet') {
    const last = value.entries[value.entries.length - 1];
    return describe(last);
  }
  if (type === 'Unit') {
    const n = value.toNumber();
    return { result: math.format(value, { precision: 12 }), type, value: Number.isFinite(n) ? n : null };
  }
  return { result: math.format(value, { precision: 14 }), type, value: null };
}

parentPort.on('message', ({ id, task }) => {
  try {
    let value;
    if (task.kind === 'evaluate') value = evaluate(task.expression);
    else value = unit(task.value, task.from).to(task.to);
    parentPort.postMessage({ id, ok: true, result: describe(value) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
});
`;

class MathEngine {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: MathResult) => void; reject: (e: Error) => void }>();

  private spawn(): Worker {
    const mathjsPath = createRequire(import.meta.url).resolve('mathjs');
    const worker = new Worker(MATH_WORKER_SOURCE, {
      eval: true,
      workerData: { mathjsPath },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 48, stackSizeMb: 8 },
    });
    worker.on('message', (msg: { id: number; ok: boolean; result?: MathResult; error?: string }) => {
      const entry = this.waiting.get(msg.id);
      if (!entry) return;
      this.waiting.delete(msg.id);
      if (msg.ok && msg.result) entry.resolve(msg.result);
      else entry.reject(new Error(translateMathError(msg.error ?? 'erro desconhecido')));
      if (this.waiting.size === 0) worker.unref();
    });
    // Eventos de um worker já substituído (após timeout) não podem afetar os pedidos do novo.
    worker.on('error', (error: unknown) => {
      if (this.worker !== worker) return;
      this.reset(new Error(`O cálculo falhou: ${error instanceof Error ? error.message : String(error)}`));
    });
    worker.on('exit', () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.failAll(new Error('O cálculo foi interrompido.'));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    for (const entry of this.waiting.values()) entry.reject(error);
    this.waiting.clear();
  }

  private reset(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    this.failAll(error);
    void worker?.terminate();
  }

  run(task: MathTask, timeoutMs = 5_000): Promise<MathResult> {
    const worker = this.worker ?? this.spawn();
    const id = ++this.seq;
    worker.ref();
    return new Promise<MathResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.waiting.has(id)) return;
        this.reset(new Error('O cálculo demorou demais e foi interrompido (limite de segurança).'));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker.postMessage({ id, task });
    });
  }

  /** Encerra o worker (encerramento do servidor/testes). */
  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error('Calculadora encerrada.'));
    await worker?.terminate();
  }
}

function translateMathError(message: string): string {
  if (/Undefined symbol (\S+)/.test(message)) {
    return `Símbolo desconhecido: ${message.match(/Undefined symbol (\S+)/)![1]}. Use nomes do mathjs (ex.: sqrt, sin, pi, e, log, km, mi, degC).`;
  }
  if (/Undefined function (\S+)/.test(message)) {
    return `Função desconhecida: ${message.match(/Undefined function (\S+)/)![1]}.`;
  }
  if (/Unit "(.+)" not found/.test(message)) return `Unidade desconhecida: ${message.match(/Unit "(.+)" not found/)![1]}.`;
  if (/Units do not match|Cannot convert/i.test(message)) return 'As unidades não são compatíveis (ex.: não dá para converter metros em quilos).';
  if (/Unexpected|Syntax|Parenthesis|Value expected/i.test(message)) return `Expressão mal formada: ${message}`;
  if (/Maximum call stack|out of memory|heap/i.test(message)) return 'O cálculo é grande demais para executar com segurança.';
  return message;
}

const mathEngine = new MathEngine();

/** Avalia uma expressão matemática em ambiente isolado (exportado para testes e outros módulos). */
export function evaluateMath(expression: string, timeoutMs?: number): Promise<MathResult> {
  return mathEngine.run({ kind: 'evaluate', expression }, timeoutMs);
}

/** Encerra o worker da calculadora. */
export function disposeMathEngine(): Promise<void> {
  return mathEngine.dispose();
}

/** Troca símbolos tipográficos comuns pelos equivalentes do mathjs. */
function normalizeExpression(expr: string): string {
  return expr
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .replace(/√\s*(\d+(?:\.\d+)?|[a-zA-Z_]\w*)/g, 'sqrt($1)')
    .replace(/√/g, 'sqrt')
    .replace(/π/g, 'pi');
}

const calculate: ToolSpec = {
  name: 'calculate',
  label: 'Calculando',
  group: 'utility',
  risk: 'safe',
  timeoutMs: 15_000,
  description:
    'Calculadora científica exata (mathjs). Use SEMPRE que houver contas — não calcule de cabeça. ' +
    'Suporta aritmética, porcentagem ("12% * 300"), potências, raízes, trigonometria ("sin(30 deg)"), log, ' +
    'matrizes ("det([1,2;3,4])"), estatística ("mean([1,2,3])", "std(...)"), números complexos, frações, ' +
    'derivadas ("derivative(\\"x^2*sin(x)\\", \\"x\\")"), simplificação e unidades ("5 km/h to mi/h"). ' +
    'Use ponto como separador decimal (3.5, nunca 3,5) e vírgula apenas para separar argumentos.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Expressão no formato mathjs, ex.: "(1500 * 1.05^12) - 1500".' },
    },
    required: ['expression'],
  },
  async execute(args) {
    const a = parseArgs(
      'calculate',
      z.object({ expression: requiredText('a expressão').max(2000, 'expressão longa demais (máx. 2000 caracteres)') }),
      args,
    );
    const expression = normalizeExpression(a.expression);
    const r = await evaluateMath(expression);
    const pretty =
      r.value !== null && r.type === 'number'
        ? r.value.toLocaleString('pt-BR', { maximumFractionDigits: 10 })
        : r.result;
    return {
      output: { expression, result: r.result, resultPtBr: pretty, type: r.type, ...(r.value !== null ? { value: r.value } : {}) },
      summary: `${expression} = ${pretty}`.slice(0, 160),
    };
  },
};

/** Apelidos em PT/EN para unidades do mathjs. */
const UNIT_ALIASES: Record<string, string> = {
  celsius: 'degC',
  'ºc': 'degC',
  '°c': 'degC',
  c: 'degC',
  fahrenheit: 'degF',
  'ºf': 'degF',
  '°f': 'degF',
  f: 'degF',
  kelvin: 'K',
  k: 'K',
  mph: 'mi/h',
  kph: 'km/h',
  kmh: 'km/h',
  'km/hora': 'km/h',
  'm/s2': 'm/s^2',
  nó: 'knot',
  nós: 'knot',
  no: 'knot',
  nos: 'knot',
  metro: 'm',
  metros: 'm',
  quilômetro: 'km',
  quilômetros: 'km',
  quilometro: 'km',
  quilometros: 'km',
  centímetro: 'cm',
  centímetros: 'cm',
  centimetro: 'cm',
  centimetros: 'cm',
  milímetro: 'mm',
  milímetros: 'mm',
  milimetro: 'mm',
  milimetros: 'mm',
  milha: 'mi',
  milhas: 'mi',
  'milha náutica': 'nmi',
  'milhas náuticas': 'nmi',
  pé: 'ft',
  pés: 'ft',
  pe: 'ft',
  pes: 'ft',
  polegada: 'inch',
  polegadas: 'inch',
  jarda: 'yd',
  jardas: 'yd',
  quilo: 'kg',
  quilos: 'kg',
  quilograma: 'kg',
  quilogramas: 'kg',
  grama: 'g',
  gramas: 'g',
  libra: 'lb',
  libras: 'lb',
  onça: 'oz',
  onças: 'oz',
  tonelada: 'tonne',
  toneladas: 'tonne',
  litro: 'L',
  litros: 'L',
  l: 'L',
  mililitro: 'mL',
  mililitros: 'mL',
  ml: 'mL',
  galão: 'gal',
  galões: 'gal',
  galao: 'gal',
  galoes: 'gal',
  xícara: 'cup',
  xícaras: 'cup',
  xicara: 'cup',
  xicaras: 'cup',
  segundo: 's',
  segundos: 's',
  minuto: 'min',
  minutos: 'min',
  hora: 'h',
  horas: 'h',
  dia: 'day',
  dias: 'day',
  semana: 'week',
  semanas: 'week',
  ano: 'year',
  anos: 'year',
  caloria: 'cal',
  calorias: 'cal',
  quilocaloria: 'kcal',
  quilocalorias: 'kcal',
  kcal: 'kcal',
  hectare: 'hectare',
  hectares: 'hectare',
  acre: 'acre',
  acres: 'acre',
  'm2': 'm^2',
  'km2': 'km^2',
  'cm2': 'cm^2',
  'm3': 'm^3',
  'cv': 'hp',
  byte: 'B',
  bytes: 'B',
  kb: 'kB',
  mb: 'MB',
  gb: 'GB',
  tb: 'TB',
};

function normalizeUnit(raw: string): string {
  const trimmed = raw.trim();
  const alias = UNIT_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

const convertUnits: ToolSpec = {
  name: 'convert_units',
  label: 'Convertendo unidades',
  group: 'utility',
  risk: 'safe',
  timeoutMs: 15_000,
  description:
    'Converte valores entre unidades físicas: comprimento, massa, volume, temperatura (degC, degF, K), ' +
    'velocidade (km/h, mi/h, m/s, knot), área, tempo, energia (J, cal, kcal, kWh), potência, pressão, dados (B, kB, MB, GB). ' +
    'Aceita nomes em português (metros, quilos, litros, polegadas, pés, milhas, celsius...). Não converte moedas.',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'number', description: 'Valor numérico a converter.' },
      from: { type: 'string', description: 'Unidade de origem (ex.: "km", "lb", "celsius", "mi/h").' },
      to: { type: 'string', description: 'Unidade de destino (ex.: "mi", "kg", "fahrenheit", "km/h").' },
    },
    required: ['value', 'from', 'to'],
  },
  async execute(args) {
    const a = parseArgs(
      'convert_units',
      z.object({
        value: z.coerce.number({ error: 'informe um valor numérico' }).refine(Number.isFinite, 'valor inválido'),
        from: requiredText('a unidade de origem').max(60),
        to: requiredText('a unidade de destino').max(60),
      }),
      args,
    );
    const from = normalizeUnit(a.from);
    const to = normalizeUnit(a.to);
    const r = await mathEngine.run({ kind: 'convert', value: a.value, from, to });
    const pretty =
      r.value !== null ? `${r.value.toLocaleString('pt-BR', { maximumFractionDigits: 6 })} ${to}` : r.result;
    return {
      output: { value: a.value, from, to, result: r.result, resultPtBr: pretty, ...(r.value !== null ? { numeric: r.value } : {}) },
      summary: `${a.value.toLocaleString('pt-BR')} ${from} = ${pretty}`,
    };
  },
};

export const utilityTools: ToolSpec[] = [getDatetime, calculate, convertUnits];
