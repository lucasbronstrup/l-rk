/**
 * Datas com fuso horário sem bibliotecas externas (apenas Intl + aritmética UTC).
 * Tudo que é persistido fica em ISO-8601 UTC (`toISOString()`).
 */
import { config } from '../config.js';

export interface WallClock {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Fuso válido: o informado, senão o do config, senão UTC. */
export function safeTimeZone(tz: string | undefined | null): string {
  for (const candidate of [tz, config.timezone, 'UTC']) {
    if (!candidate) continue;
    try {
      partsFormatter(candidate);
      return candidate;
    } catch {
      // tenta o próximo
    }
  }
  return 'UTC';
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** Componentes de relógio local de um instante no fuso indicado. */
export function toWallClock(date: Date, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: date.getUTCMilliseconds(),
  };
}

/** Deslocamento (ms) do fuso em relação ao UTC no instante dado: local − UTC. */
function offsetAt(utcMs: number, timeZone: string): number {
  const w = toWallClock(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
  return asUtc - utcMs;
}

/**
 * Converte um horário de parede no fuso para o instante UTC correspondente.
 * Em lacunas de horário de verão o resultado avança para o primeiro horário válido;
 * em horários ambíguos escolhe a primeira ocorrência.
 */
export function wallClockToDate(w: WallClock, timeZone: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  if (first === second) return new Date(first);
  // Ambíguo ou lacuna: prefere o candidato cujo relógio local bate com o pedido.
  const matches = (ms: number) => offsetAt(ms, timeZone) === guess - ms;
  if (matches(first) && matches(second)) return new Date(Math.min(first, second));
  if (matches(second)) return new Date(second);
  if (matches(first)) return new Date(first);
  return new Date(Math.max(first, second));
}

/** Soma dias a uma data de calendário (sem fuso). */
export function addCalendarDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Dia da semana (0 = domingo) de uma data de calendário. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

export class InvalidDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDateError';
  }
}

/**
 * Interpreta uma data ISO-8601 e devolve o instante em UTC (`toISOString()`).
 * - Com offset (`Z`, `-03:00`): usado como está.
 * - Sem offset: interpretada no fuso `timeZone` (horário local do usuário).
 * - Só a data (`2026-10-17`): usa `dateOnlyTime` (HH:MM) no fuso informado.
 * @throws InvalidDateError com mensagem clara em PT-BR.
 */
export function parseUserDate(
  input: string,
  opts: { timeZone?: string; dateOnlyTime?: string } = {},
): string {
  const raw = String(input ?? '').trim();
  const m = ISO_RE.exec(raw);
  if (!m) {
    throw new InvalidDateError(
      `Data inválida: "${raw}". Use o formato ISO-8601 com fuso, por exemplo 2026-10-17T09:00:00-03:00.`,
    );
  }
  const [, ys, mos, ds, hs, mis, ss, frac, offset] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new InvalidDateError(`Data inválida: "${raw}" não existe no calendário.`);
  }
  let hour: number;
  let minute: number;
  if (hs === undefined) {
    const [dh, dm] = (opts.dateOnlyTime ?? '09:00').split(':').map(Number);
    hour = dh;
    minute = dm;
  } else {
    hour = Number(hs);
    minute = Number(mis);
  }
  const second = ss ? Number(ss) : 0;
  const millisecond = frac ? Math.round(Number(`0.${frac}`) * 1000) % 1000 : 0;
  if (hour > 23 || minute > 59 || second > 59) {
    throw new InvalidDateError(`Horário inválido em "${raw}".`);
  }

  if (offset) {
    let offsetMinutes = 0;
    if (offset.toUpperCase() !== 'Z') {
      const sign = offset.startsWith('-') ? -1 : 1;
      const digits = offset.slice(1).replace(':', '');
      const oh = Number(digits.slice(0, 2));
      const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
      if (oh > 14 || om > 59) throw new InvalidDateError(`Fuso horário inválido em "${raw}".`);
      offsetMinutes = sign * (oh * 60 + om);
    }
    const utc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60_000;
    return new Date(utc).toISOString();
  }

  const tz = safeTimeZone(opts.timeZone);
  return wallClockToDate({ year, month, day, hour, minute, second, millisecond }, tz).toISOString();
}

/** Normaliza uma data opcional (null/vazio → null). */
export function parseOptionalUserDate(
  input: string | null | undefined,
  opts: { timeZone?: string; dateOnlyTime?: string } = {},
): string | null {
  if (input === null || input === undefined || String(input).trim() === '') return null;
  return parseUserDate(input, opts);
}

const humanFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** Data por extenso em PT-BR no fuso do usuário (ex.: "sexta-feira, 17 de outubro de 2026 às 09:00"). */
export function formatLocalDateTime(iso: string, timeZone: string): string {
  const tz = safeTimeZone(timeZone);
  let fmt = humanFormatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
    humanFormatterCache.set(tz, fmt);
  }
  return fmt.format(new Date(iso));
}
