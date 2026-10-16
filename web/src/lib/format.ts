/**
 * Formatação para a interface do Lärk (pt-BR): datas relativas, prazos, contagens
 * regressivas, bytes, taxas e durações. Funções puras — fáceis de testar e reutilizar.
 */

const LOCALE = 'pt-BR';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const numberFmt = new Intl.NumberFormat(LOCALE);
const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto', style: 'long' });

/** Converte ISO/Date/epoch em milissegundos; NaN quando inválido. */
export function toMs(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}

/** Número com separador de milhar pt-BR ("12.430"). */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return numberFmt.format(n);
}

/** "1 memória" / "3 memórias". */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${formatNumber(n)} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

// ─── Datas relativas ─────────────────────────────────────────────────────

/**
 * Tempo relativo curto e natural: "agora", "há 5 min", "em 3 h", "ontem", "há 2 dias", "em 3 semanas".
 * Abaixo de 1 minuto devolve "agora".
 */
export function relativeTime(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const t = toMs(value);
  if (Number.isNaN(t)) return '—';
  const diff = t - now;
  const abs = Math.abs(diff);
  const sign = diff < 0 ? -1 : 1;

  if (abs < 45 * SECOND) return 'agora';
  if (abs < HOUR) {
    const m = Math.max(1, Math.round(abs / MINUTE));
    return sign < 0 ? `há ${m} min` : `em ${m} min`;
  }
  if (abs < DAY) {
    const h = Math.round(abs / HOUR);
    return sign < 0 ? `há ${h} h` : `em ${h} h`;
  }
  const days = calendarDayDiff(t, now);
  if (Math.abs(days) < 7) return rtf.format(days, 'day');
  if (Math.abs(days) < 30) return rtf.format(Math.round(days / 7), 'week');
  if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), 'month');
  return rtf.format(Math.round(days / 365), 'year');
}

/** Diferença em dias de calendário (local) entre dois instantes: amanhã = 1, ontem = -1. */
export function calendarDayDiff(target: number, now: number = Date.now()): number {
  const a = new Date(target);
  const b = new Date(now);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da - db) / DAY);
}

/** Dias inteiros desde uma data (0 no mesmo dia). */
export function daysSince(value: string | null | undefined, now: number = Date.now()): number | null {
  const t = toMs(value);
  if (Number.isNaN(t)) return null;
  return Math.max(0, -calendarDayDiff(t, now));
}

// ─── Prazos de promessas ────────────────────────────────────────────────

export interface DueInfo {
  /** Rótulo humano: "vence em 3 h", "atrasada há 2 dias", "vence hoje às 18:00". */
  label: string;
  overdue: boolean;
  /** Vence nas próximas 3 horas. */
  urgent: boolean;
}

/** Descreve o prazo de uma promessa em relação a agora. */
export function describeDue(dueAt: string | null | undefined, now: number = Date.now()): DueInfo | null {
  const t = toMs(dueAt);
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  if (diff < 0) {
    const abs = -diff;
    let span: string;
    if (abs < HOUR) span = `${Math.max(1, Math.round(abs / MINUTE))} min`;
    else if (abs < DAY) span = plural(Math.round(abs / HOUR), 'hora');
    else span = plural(Math.max(1, Math.floor(abs / DAY)), 'dia');
    return { label: `atrasada há ${span}`, overdue: true, urgent: true };
  }
  let label: string;
  if (diff < HOUR) label = `vence em ${Math.max(1, Math.round(diff / MINUTE))} min`;
  else if (diff < 12 * HOUR) label = `vence em ${Math.round(diff / HOUR)} h`;
  else {
    const days = calendarDayDiff(t, now);
    if (days === 0) label = `vence hoje às ${formatTime(t)}`;
    else if (days === 1) label = `vence amanhã às ${formatTime(t)}`;
    else if (days < 7) label = `vence ${weekdayName(t)} às ${formatTime(t)}`;
    else label = `vence em ${formatDate(t)}`;
  }
  return { label, overdue: false, urgent: diff < 3 * HOUR };
}

// ─── Contagem regressiva ─────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Contagem regressiva compacta: "00:04:12" (< 24 h) ou "3d 04h" (≥ 24 h).
 * Valores negativos são tratados como zero.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${pad(h)}h`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Duração legível de um intervalo em segundos: "3 d 4 h", "5 h 12 min", "42 s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

// ─── Datas absolutas ─────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(opts: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const key = JSON.stringify([opts, timeZone ?? '']);
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(LOCALE, timeZone ? { ...opts, timeZone } : opts);
    } catch {
      // Fuso inválido nas configurações: cai para o fuso do navegador.
      f = new Intl.DateTimeFormat(LOCALE, opts);
    }
    fmtCache.set(key, f);
  }
  return f;
}

/** "14:30". */
export function formatTime(value: string | number | Date, timeZone?: string): string {
  const t = toMs(value);
  if (Number.isNaN(t)) return '—';
  return dtf({ hour: '2-digit', minute: '2-digit' }, timeZone).format(t);
}

/** "16 out." (ano incluído quando diferente do atual). */
export function formatDate(value: string | number | Date, timeZone?: string): string {
  const t = toMs(value);
  if (Number.isNaN(t)) return '—';
  const sameYear = new Date(t).getFullYear() === new Date().getFullYear();
  return dtf(sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' }, timeZone).format(t);
}

/** "qui., 16 out., 14:30" — data e hora completas e compactas. */
export function formatDateTime(value: string | number | Date, timeZone?: string): string {
  const t = toMs(value);
  if (Number.isNaN(t)) return '—';
  return dtf({ weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }, timeZone).format(t);
}

/** "hoje às 14:30", "amanhã às 09:00", "sex. às 18:00", "24 out. às 10:00". */
export function formatWhen(value: string | number | Date, now: number = Date.now()): string {
  const t = toMs(value);
  if (Number.isNaN(t)) return '—';
  const days = calendarDayDiff(t, now);
  const time = formatTime(t);
  if (days === 0) return `hoje às ${time}`;
  if (days === 1) return `amanhã às ${time}`;
  if (days === -1) return `ontem às ${time}`;
  if (days > 1 && days < 7) return `${weekdayName(t)} às ${time}`;
  return `${formatDate(t)} às ${time}`;
}

function weekdayName(t: number): string {
  return dtf({ weekday: 'long' }).format(t);
}

/** Agrupamento temporal para listas: "Hoje", "Ontem", "Esta semana", "Este mês", "Anteriores". */
export function dateBucket(value: string, now: number = Date.now()): string {
  const t = toMs(value);
  if (Number.isNaN(t)) return 'Anteriores';
  const days = -calendarDayDiff(t, now);
  if (days <= 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days < 7) return 'Esta semana';
  if (days < 31) return 'Este mês';
  return 'Anteriores';
}

// ─── <input type="datetime-local"> ──────────────────────────────────────

/** Date → "2026-10-16T14:30" no fuso local do navegador. */
export function toLocalInputValue(value: string | number | Date): string {
  const d = new Date(toMs(value));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-10-16T14:30" (local) → ISO UTC; null quando vazio/inválido. */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── Bytes e taxas ───────────────────────────────────────────────────────

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 → "1,5 KB". Base 1024, uma casa decimal quando útil. */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const exp = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** exp;
  const fmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: v >= 100 ? 0 : digits, minimumFractionDigits: 0 });
  return `${fmt.format(v)} ${UNITS[exp]}`;
}

/** Bytes por segundo → "1,2 MB/s". */
export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '—';
  return `${formatBytes(Math.max(0, bytesPerSec))}/s`;
}

/** 42.37 → "42%". */
export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits }).format(value)}%`;
}

/** Corta um texto em `max` caracteres, sem quebrar no meio de palavra quando possível. */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
