import { useUi } from '@/store/ui';

/**
 * Agregador do nível de voz exibido pela HUD (useUi.voiceLevel).
 * Cada fonte (microfone, voz do Lärk, ditado) registra uma função de leitura com prioridade;
 * um único laço requestAnimationFrame lê a fonte de maior prioridade e suaviza o valor.
 */

interface LevelSource {
  read: () => number;
  priority: number;
  order: number;
}

const sources = new Map<string, LevelSource>();
let raf = 0;
let smoothed = 0;
let lastPublished = -1;
let order = 0;

/** Prioridades sugeridas: fala do Lärk acima do microfone. */
export const LEVEL_PRIORITY = { mic: 1, dictation: 1, speech: 3 } as const;

/** Registra (ou remove, com `read = null`) uma fonte de nível. */
export function setLevelSource(key: string, read: (() => number) | null, priority = 1): void {
  if (read) sources.set(key, { read, priority, order: ++order });
  else sources.delete(key);
  ensureLoop();
}

function pickSource(): LevelSource | null {
  let best: LevelSource | null = null;
  for (const s of sources.values()) {
    if (!best || s.priority > best.priority || (s.priority === best.priority && s.order > best.order)) best = s;
  }
  return best;
}

function publish(v: number) {
  const rounded = Math.round(v * 1000) / 1000;
  if (Math.abs(rounded - lastPublished) < 0.004 && !(rounded === 0 && lastPublished !== 0)) return;
  lastPublished = rounded;
  useUi.getState().setVoiceLevel(rounded);
}

function tick() {
  raf = 0;
  const src = pickSource();
  let target = 0;
  if (src) {
    try {
      target = Math.max(0, Math.min(1, src.read()));
    } catch {
      target = 0;
    }
  }
  // Ataque rápido, liberação suave: a HUD "respira" junto com a voz.
  const k = target > smoothed ? 0.5 : 0.14;
  smoothed += (target - smoothed) * k;
  if (smoothed < 0.002) smoothed = 0;
  publish(smoothed);
  if (sources.size > 0 || smoothed > 0) raf = requestAnimationFrame(tick);
}

function ensureLoop() {
  if (raf || typeof requestAnimationFrame === 'undefined') return;
  raf = requestAnimationFrame(tick);
}
