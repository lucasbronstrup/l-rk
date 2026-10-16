/**
 * Utilitários das falas proativas do Lärk (lembretes, cobranças, briefing):
 * geração curta no estilo do orador via Gemini (modelo 'fast'), com fallback de template quando
 * não há chave, no modo demonstração ou em qualquer falha — a fala proativa nunca deixa de sair.
 */
import { config } from '../config.js';
import { getClient, generateText } from '../llm/gemini.js';
import { buildPersona } from '../agent/persona.js';
import { getSettings } from '../memory/settings.js';
import { safeTimeZone, toWallClock, type WallClock } from '../memory/time.js';
import type { Settings } from '../../shared/types.js';

/** Tempo máximo de espera pela IA numa fala proativa (depois disso, usa o template). */
const PROACTIVE_AI_TIMEOUT_MS = 25_000;

/** true quando dá para pedir texto ao Gemini (chave presente e fora do modo demonstração). */
export function canUseAi(): boolean {
  if (config.mock) return false;
  try {
    return getClient() !== null;
  } catch {
    return false;
  }
}

/** Remove aspas/blocos de código que o modelo às vezes coloca em volta da resposta. */
export function cleanGenerated(text: string): string {
  let out = text.trim();
  out = out.replace(/^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  if (/^["“«].*["”»]$/s.test(out) && !out.slice(1, -1).match(/["“”«»]/)) out = out.slice(1, -1).trim();
  return out;
}

export interface ComposeOptions {
  /** O que o Lärk deve escrever agora (vai junto da persona no system instruction). */
  task: string;
  /** Dados do momento (lembrete, promessa, agenda...). */
  prompt: string;
  /** Texto usado quando a IA não está disponível ou falha. */
  fallback: string;
  maxOutputTokens?: number;
  /** Limite de palavras: respostas muito acima disso caem no fallback. */
  maxWords?: number;
  settings?: Settings;
}

/** Gera a fala proativa no estilo do Lärk; devolve o fallback em mock/sem chave/erro. */
export async function composeWithLark(opts: ComposeOptions): Promise<string> {
  if (!canUseAi()) return opts.fallback;
  const settings = opts.settings ?? getSettings();
  try {
    const system = `${buildPersona(settings, 'text')}\n\n# TAREFA DESTE MOMENTO (fala proativa — ninguém te perguntou nada)\n${opts.task}`;
    const raw = await generateText({
      system,
      prompt: opts.prompt,
      role: 'fast',
      temperature: 0.9,
      maxOutputTokens: opts.maxOutputTokens ?? 400,
      timeoutMs: PROACTIVE_AI_TIMEOUT_MS,
    });
    const text = cleanGenerated(raw);
    if (!text) return opts.fallback;
    if (opts.maxWords && text.split(/\s+/).length > opts.maxWords * 1.6) return opts.fallback;
    return text;
  } catch (error) {
    console.warn('[proatividade] IA indisponível, usando template:', error instanceof Error ? error.message : error);
    return opts.fallback;
  }
}

// ─── Datas no fuso do usuário ────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

export function wallClock(date: Date, timeZone: string): WallClock {
  return toWallClock(date, safeTimeZone(timeZone));
}

/** "HH:MM" no fuso do usuário. */
export function timeLabel(iso: string | Date, timeZone: string): string {
  const w = wallClock(typeof iso === 'string' ? new Date(iso) : iso, timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** "AAAA-MM-DD" (data local) no fuso do usuário. */
export function localDateKey(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Minutos desde a meia-noite local. */
export function minutesOfDay(date: Date, timeZone: string): number {
  const w = wallClock(date, timeZone);
  return w.hour * 60 + w.minute;
}

/** "HH:MM" → minutos desde a meia-noite (null se inválido). */
export function parseHhmm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const weekdayFormatter = new Map<string, Intl.DateTimeFormat>();

/** Data amigável em PT-BR: "hoje às 09:00", "amanhã às 14:30", "sexta-feira, 17/10 às 09:00". */
export function friendlyDateTime(iso: string, timeZone: string, now: Date = new Date()): string {
  const tz = safeTimeZone(timeZone);
  const date = new Date(iso);
  const time = timeLabel(date, tz);
  const key = localDateKey(date, tz);
  if (key === localDateKey(now, tz)) return `hoje às ${time}`;
  if (key === localDateKey(new Date(now.getTime() + 86_400_000), tz)) return `amanhã às ${time}`;
  if (key === localDateKey(new Date(now.getTime() - 86_400_000), tz)) return `ontem às ${time}`;
  let fmt = weekdayFormatter.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit' });
    weekdayFormatter.set(tz, fmt);
  }
  return `${fmt.format(date)} às ${time}`;
}

/** Escolhe um item de forma determinística (mesma semente → mesmo item), para variar templates. */
export function pick<T>(items: readonly T[], seed: string): T {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return items[hash % items.length];
}

/** Vocativo opcional: ", Lucas" quando o nome é conhecido. */
export function vocative(settings: Settings): string {
  const name = settings.userName.trim();
  return name ? `, ${name}` : '';
}
