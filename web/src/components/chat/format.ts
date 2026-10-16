import type { ChatMessage } from '@shared/types';

/** Formatação de datas/horas do chat em pt-BR (com fuso das configurações quando válido). */

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, opts: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const id = `${key}|${timeZone ?? ''}`;
  let f = timeFormatters.get(id);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('pt-BR', { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('pt-BR', opts);
    }
    timeFormatters.set(id, f);
  }
  return f;
}

export function formatTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return formatter('time', { hour: '2-digit', minute: '2-digit' }, timeZone).format(d);
}

/** Chave do dia (AAAA-MM-DD) no fuso informado — para separadores de data. */
export function dayKey(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = formatter('day', { year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Rótulo do separador de dia: HOJE, ONTEM ou "12 OUT 2026". */
export function dayLabel(iso: string, timeZone?: string): string {
  const key = dayKey(iso, timeZone);
  const now = new Date();
  if (key === dayKey(now.toISOString(), timeZone)) return 'Hoje';
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (key === dayKey(yesterday.toISOString(), timeZone)) return 'Ontem';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === now.getFullYear();
  return formatter(sameYear ? 'dlabel' : 'dlabely', sameYear ? { day: '2-digit', month: 'short', weekday: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' }, timeZone)
    .format(d)
    .replace(/\./g, '');
}

/** Saudação conforme a hora local. */
export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** Mensagem recém-criada (para animar só o que chega agora, não o histórico). */
export function isFresh(m: ChatMessage, windowMs = 20_000): boolean {
  const t = Date.parse(m.createdAt);
  return Number.isFinite(t) && Date.now() - t < windowMs;
}

export type ProactiveFlavor = 'reminder' | 'checkin' | 'briefing';

/** Classifica mensagens proativas para o rótulo da faixa (LEMBRETE / COBRANÇA / BRIEFING). */
export function proactiveFlavor(m: ChatMessage): ProactiveFlavor | null {
  if (m.kind === 'briefing') return 'briefing';
  if (m.kind !== 'proactive') return null;
  const t = m.content.toLowerCase();
  if (/\blembrete\b|\blembrar\b|\blembra\b/.test(t) && !/prometeu|promessa|compromisso/.test(t)) return 'reminder';
  if (/prometeu|promessa|compromisso|combinamos|combinado|conseguiu|cumpriu|fez o que|e a[ií],? (j[aá] )?fez/.test(t)) return 'checkin';
  return 'reminder';
}

/** Extrai texto puro de nós React (conteúdo de blocos de código). */
export function nodeText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    return nodeText((node as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

/** Copia para a área de transferência com reserva para navegadores antigos/HTTP. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* tenta a reserva abaixo */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
