/**
 * Datas com fuso horário sem bibliotecas (Intl + aritmética UTC) — versão de navegador de
 * server/memory/time.ts. Tudo que é persistido fica em ISO-8601 UTC.
 */
import type { Recurrence } from '@shared/types';

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

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    partsFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimeZone(tz)) return tz;
  } catch {
    /* ignorado */
  }
  return 'America/Sao_Paulo';
}

export function safeTimeZone(tz: string | null | undefined): string {
  if (isValidTimeZone(tz)) return tz;
  const dev = deviceTimeZone();
  return isValidTimeZone(dev) ? dev : 'UTC';
}

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
export function offsetAt(utcMs: number, timeZone: string): number {
  const w = toWallClock(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
  return asUtc - utcMs;
}

export function wallClockToDate(w: WallClock, timeZone: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  if (first === second) return new Date(first);
  const matches = (ms: number) => offsetAt(ms, timeZone) === guess - ms;
  if (matches(first) && matches(second)) return new Date(Math.min(first, second));
  if (matches(second)) return new Date(second);
  if (matches(first)) return new Date(first);
  return new Date(Math.max(first, second));
}

export function addCalendarDays(year: number, month: number, day: number, days: number) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** "+HH:MM" / "-HH:MM" do fuso no instante. */
export function offsetLabel(date: Date, timeZone: string): string {
  const mins = Math.round(offsetAt(date.getTime(), timeZone) / 60_000);
  const sign = mins < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(mins) / 60))}:${pad(Math.abs(mins) % 60)}`;
}

/** ISO local com offset, ex.: 2026-10-16T15:42:00-03:00. */
export function toLocalIso(date: Date, timeZone: string): string {
  const tz = safeTimeZone(timeZone);
  const w = toWallClock(date, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offsetLabel(date, tz)}`;
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
 * Interpreta ISO-8601 e devolve o instante UTC. Sem offset → horário local do usuário.
 * Só a data → `dateOnlyTime` (HH:MM) no fuso.
 */
export function parseUserDate(input: string, opts: { timeZone?: string; dateOnlyTime?: string } = {}): string {
  const rawText = String(input ?? '').trim();
  const m = ISO_RE.exec(rawText);
  if (!m) {
    throw new InvalidDateError(
      `Data inválida: "${rawText}". Use o formato ISO-8601 com fuso, por exemplo 2026-10-17T09:00:00-03:00.`,
    );
  }
  const [, ys, mos, ds, hs, mis, ss, frac, offset] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new InvalidDateError(`Data inválida: "${rawText}" não existe no calendário.`);
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
  if (hour > 23 || minute > 59 || second > 59) throw new InvalidDateError(`Horário inválido em "${rawText}".`);

  if (offset) {
    let offsetMinutes = 0;
    if (offset.toUpperCase() !== 'Z') {
      const sign = offset.startsWith('-') ? -1 : 1;
      const digits = offset.slice(1).replace(':', '');
      const oh = Number(digits.slice(0, 2));
      const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
      if (oh > 14 || om > 59) throw new InvalidDateError(`Fuso horário inválido em "${rawText}".`);
      offsetMinutes = sign * (oh * 60 + om);
    }
    const utc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60_000;
    return new Date(utc).toISOString();
  }
  const tz = safeTimeZone(opts.timeZone);
  return wallClockToDate({ year, month, day, hour, minute, second, millisecond }, tz).toISOString();
}

export function parseOptionalUserDate(
  input: string | null | undefined,
  opts: { timeZone?: string; dateOnlyTime?: string } = {},
): string | null {
  if (input === null || input === undefined || String(input).trim() === '') return null;
  return parseUserDate(input, opts);
}

const humanCache = new Map<string, Intl.DateTimeFormat>();

function human(tz: string, key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${tz}|${key}`;
  let f = humanCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, ...opts });
    humanCache.set(k, f);
  }
  return f;
}

/** "sexta-feira, 17 de outubro de 2026 às 09:00". */
export function formatLocalDateTime(iso: string, timeZone: string): string {
  return human(safeTimeZone(timeZone), 'full', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));
}

/** "09:00". */
export function formatLocalTime(iso: string, timeZone: string): string {
  return human(safeTimeZone(timeZone), 'time', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** "hoje às 09:00", "amanhã às 09:00" ou "sex., 17/10 às 09:00". */
export function formatRelative(iso: string, timeZone: string, now = new Date()): string {
  const tz = safeTimeZone(timeZone);
  const w = toWallClock(new Date(iso), tz);
  const n = toWallClock(now, tz);
  const dayKey = (x: { year: number; month: number; day: number }) => Date.UTC(x.year, x.month - 1, x.day);
  const diffDays = Math.round((dayKey(w) - dayKey(n)) / 86_400_000);
  const time = formatLocalTime(iso, tz);
  if (diffDays === 0) return `hoje às ${time}`;
  if (diffDays === 1) return `amanhã às ${time}`;
  if (diffDays === -1) return `ontem às ${time}`;
  const date = human(tz, 'short', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(iso));
  return `${date} às ${time}`;
}

/** Hora local (0–23) e minuto do instante no fuso. */
export function localHourMinute(date: Date, timeZone: string): { hour: number; minute: number } {
  const w = toWallClock(date, safeTimeZone(timeZone));
  return { hour: w.hour, minute: w.minute };
}

export function nextOccurrence(dueAt: string, recurrence: Recurrence, timezone: string): string | null {
  if (recurrence === 'none') return null;
  const base = new Date(dueAt);
  if (Number.isNaN(base.getTime())) return null;
  const tz = safeTimeZone(timezone);
  const w = toWallClock(base, tz);
  let date: { year: number; month: number; day: number };
  switch (recurrence) {
    case 'daily':
      date = addCalendarDays(w.year, w.month, w.day, 1);
      break;
    case 'weekly':
      date = addCalendarDays(w.year, w.month, w.day, 7);
      break;
    case 'weekdays': {
      date = addCalendarDays(w.year, w.month, w.day, 1);
      while ([0, 6].includes(weekdayOf(date.year, date.month, date.day))) {
        date = addCalendarDays(date.year, date.month, date.day, 1);
      }
      break;
    }
    case 'monthly': {
      const year = w.month === 12 ? w.year + 1 : w.year;
      const month = w.month === 12 ? 1 : w.month + 1;
      date = { year, month, day: Math.min(w.day, daysInMonth(year, month)) };
      break;
    }
    default:
      return null;
  }
  const next = wallClockToDate({ ...w, ...date }, tz);
  return next.getTime() > base.getTime() ? next.toISOString() : null;
}

/** Primeira ocorrência posterior a `after` (pula ocorrências perdidas com a página fechada). */
export function nextOccurrenceAfter(dueAt: string, recurrence: Recurrence, timezone: string, after: Date): string | null {
  let current: string | null = dueAt;
  for (let i = 0; i < 2000 && current; i++) {
    current = nextOccurrence(current, recurrence, timezone);
    if (current && new Date(current).getTime() > after.getTime()) return current;
  }
  return null;
}

/** "23:00" → minutos desde 00:00 (null se inválido). */
export function hhmmToMinutes(v: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** true se o instante cai no horário de silêncio (intervalo que pode cruzar a meia-noite). */
export function inQuietHours(date: Date, timeZone: string, start: string, end: string): boolean {
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  if (s === null || e === null || s === e) return false;
  const { hour, minute } = localHourMinute(date, timeZone);
  const now = hour * 60 + minute;
  return s < e ? now >= s && now < e : now >= s || now < e;
}
