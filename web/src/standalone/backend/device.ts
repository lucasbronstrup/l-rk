/**
 * Sinais vitais plausíveis do aparelho (via APIs do navegador) e lista de vozes do Gemini.
 * A edição web não enxerga processos, discos nem a rede da máquina.
 */
import type { SystemVitals } from '@shared/types';

interface BatteryLike {
  level: number;
  charging: boolean;
}

interface NavigatorExtras {
  deviceMemory?: number;
  getBattery?: () => Promise<BatteryLike>;
  connection?: { effectiveType?: string; downlink?: number; type?: string };
  userAgentData?: { platform?: string; mobile?: boolean };
}

function osName(): string {
  const nav = navigator as Navigator & NavigatorExtras;
  const p = nav.userAgentData?.platform;
  if (p) return p;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Navegador';
}

function browserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Navegador';
}

export async function getDeviceVitals(): Promise<SystemVitals> {
  const nav = navigator as Navigator & NavigatorExtras;
  const cores = navigator.hardwareConcurrency || 0;
  const totalBytes = nav.deviceMemory ? nav.deviceMemory * 1024 ** 3 : 0;
  const heap = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize ?? 0;
  const usedBytes = totalBytes ? Math.min(heap, totalBytes) : 0;

  let battery: SystemVitals['battery'] = { hasBattery: false, percent: null, charging: null };
  try {
    if (typeof nav.getBattery === 'function') {
      const b = await Promise.race([nav.getBattery(), new Promise<null>((r) => setTimeout(() => r(null), 800))]);
      if (b) battery = { hasBattery: true, percent: Math.round(b.level * 100), charging: b.charging };
    }
  } catch {
    /* API de bateria indisponível */
  }

  const disks: SystemVitals['disks'] = [];
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) {
      const used = est.usage ?? 0;
      disks.push({ mount: 'Armazenamento do site', totalBytes: est.quota, usedBytes: used, usedPct: Math.round((used / est.quota) * 1000) / 10 });
    }
  } catch {
    /* ignorado */
  }

  const conn = nav.connection;
  return {
    hostname: 'Navegador',
    platform: 'web',
    osName: `${osName()} · ${browserName()}`,
    uptimeSec: Math.round(performance.now() / 1000),
    cpu: { model: cores ? `${cores} núcleos lógicos (informados pelo navegador)` : 'Processador do aparelho', cores, loadPct: 0, tempC: null },
    memory: { totalBytes, usedBytes, usedPct: totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0 },
    disks,
    battery,
    network: conn
      ? { iface: conn.effectiveType ? conn.effectiveType.toUpperCase() : conn.type ?? 'rede', ip4: null, rxSec: conn.downlink ? Math.round(conn.downlink * 125_000) : null, txSec: null }
      : null,
    topProcesses: [],
  };
}

/** Vozes pré-definidas do Gemini TTS, com descrição em PT-BR. */
export const GEMINI_VOICES: { name: string; description: string }[] = [
  { name: 'Charon', description: 'Informativa e grave — a voz de palestrante do Lärk' },
  { name: 'Orus', description: 'Firme e segura' },
  { name: 'Puck', description: 'Animada e otimista' },
  { name: 'Kore', description: 'Firme e direta' },
  { name: 'Fenrir', description: 'Empolgada, cheia de energia' },
  { name: 'Aoede', description: 'Leve e arejada' },
  { name: 'Zephyr', description: 'Clara e brilhante' },
  { name: 'Iapetus', description: 'Nítida e articulada' },
  { name: 'Algenib', description: 'Rouca, com textura' },
  { name: 'Rasalgethi', description: 'Informativa, tom de apresentador' },
  { name: 'Alnilam', description: 'Firme e determinada' },
  { name: 'Schedar', description: 'Equilibrada e serena' },
  { name: 'Gacrux', description: 'Madura e experiente' },
  { name: 'Sadaltager', description: 'Erudita, de quem domina o assunto' },
  { name: 'Achird', description: 'Amigável e acolhedora' },
  { name: 'Enceladus', description: 'Soprosa, intimista' },
  { name: 'Umbriel', description: 'Tranquila e descontraída' },
  { name: 'Algieba', description: 'Suave e aveludada' },
  { name: 'Despina', description: 'Suave e fluida' },
  { name: 'Erinome', description: 'Clara e precisa' },
  { name: 'Laomedeia', description: 'Animada e leve' },
  { name: 'Achernar', description: 'Delicada e macia' },
  { name: 'Callirrhoe', description: 'Descontraída e tranquila' },
  { name: 'Autonoe', description: 'Brilhante e expressiva' },
  { name: 'Leda', description: 'Jovem e jovial' },
  { name: 'Vindemiatrix', description: 'Gentil e calma' },
  { name: 'Sadachbia', description: 'Vívida e enérgica' },
  { name: 'Pulcherrima', description: 'Assertiva, vai direto ao ponto' },
  { name: 'Zubenelgenubi', description: 'Casual, papo de amigo' },
];
