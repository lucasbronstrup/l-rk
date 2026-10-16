/**
 * Catálogo de vozes pré-definidas do Gemini (TTS e Live) com descrições em português.
 *
 * A lista fixa é a fonte confiável (todas funcionam com `prebuiltVoiceConfig.voiceName`).
 * Quando há chave, tentamos também o catálogo oficial (`ai.voices.list`) para descobrir vozes
 * novas; qualquer falha cai silenciosamente para a lista fixa.
 */
import { config } from '../config.js';
import { getClient } from '../llm/gemini.js';

export interface VoiceInfo {
  /** Nome exato aceito pelo Gemini (ex.: "Charon"). */
  name: string;
  /** Descrição curta em PT-BR para a tela de configurações. */
  description: string;
}

/** Voz padrão do Lärk: informativa e grave, perfeita para um orador sereno. */
export const DEFAULT_VOICE = 'Charon';

/** Vozes pré-definidas do Gemini, das mais adequadas ao Lärk às demais. */
export const GEMINI_VOICES: readonly VoiceInfo[] = Object.freeze([
  { name: 'Charon', description: 'Masculina, informativa e grave — a voz padrão do Lärk, de orador sereno e seguro.' },
  { name: 'Orus', description: 'Masculina e firme — presença de quem conduz a conversa com convicção.' },
  { name: 'Alnilam', description: 'Masculina e firme — direta, com autoridade tranquila.' },
  { name: 'Rasalgethi', description: 'Masculina e informativa — tom de professor que explica com clareza.' },
  { name: 'Sadaltager', description: 'Masculina e conhecedora — soa como quem domina o assunto.' },
  { name: 'Iapetus', description: 'Masculina e clara — dicção limpa, ótima para explicações longas.' },
  { name: 'Algenib', description: 'Masculina e rouca — textura marcante, com personalidade.' },
  { name: 'Schedar', description: 'Masculina e equilibrada — constante, sem exageros.' },
  { name: 'Umbriel', description: 'Masculina e tranquila — conversa leve, sem pressa.' },
  { name: 'Algieba', description: 'Masculina e suave — aveludada e acolhedora.' },
  { name: 'Achird', description: 'Masculina e amigável — calorosa, como um bom amigo.' },
  { name: 'Zubenelgenubi', description: 'Masculina e casual — descontraída, de conversa de bar.' },
  { name: 'Puck', description: 'Masculina e animada — energia alta, ritmo contagiante.' },
  { name: 'Fenrir', description: 'Masculina e empolgada — intensa, cheia de entusiasmo.' },
  { name: 'Sadachbia', description: 'Masculina e vivaz — dinâmica e expressiva.' },
  { name: 'Enceladus', description: 'Masculina e sussurrada — íntima, quase confidencial.' },
  { name: 'Kore', description: 'Feminina e firme — segura e objetiva.' },
  { name: 'Gacrux', description: 'Feminina e madura — experiente, de quem já viu muita coisa.' },
  { name: 'Pulcherrima', description: 'Feminina e direta — vai ao ponto, com elegância.' },
  { name: 'Erinome', description: 'Feminina e clara — articulada e precisa.' },
  { name: 'Zephyr', description: 'Feminina e brilhante — luminosa e otimista.' },
  { name: 'Autonoe', description: 'Feminina e brilhante — viva, com sorriso na voz.' },
  { name: 'Aoede', description: 'Feminina e leve — fluida, como uma brisa.' },
  { name: 'Callirrhoe', description: 'Feminina e tranquila — calma e descomplicada.' },
  { name: 'Despina', description: 'Feminina e suave — delicada e agradável.' },
  { name: 'Achernar', description: 'Feminina e suave — macia, de tom baixo.' },
  { name: 'Vindemiatrix', description: 'Feminina e gentil — cuidadosa e acolhedora.' },
  { name: 'Sulafat', description: 'Feminina e calorosa — próxima e afetuosa.' },
  { name: 'Laomedeia', description: 'Feminina e animada — alegre e enérgica.' },
  { name: 'Leda', description: 'Feminina e jovem — fresca e espontânea.' },
]);

const REMOTE_TTL_MS = 24 * 60 * 60_000;
const REMOTE_FAILURE_TTL_MS = 60 * 60_000;
const REMOTE_TIMEOUT_MS = 8_000;

/** Vozes descobertas no catálogo oficial que não estão na lista fixa. */
let remoteExtras: VoiceInfo[] = [];
let remoteFetchedAt = 0;
let remoteFailedAt = 0;
let remoteInflight: Promise<void> | null = null;

const byLowerName = new Map(GEMINI_VOICES.map((v) => [v.name.toLowerCase(), v]));

/** Procura uma voz conhecida (lista fixa ou catálogo remoto), sem diferenciar maiúsculas. */
export function findVoice(name: string | null | undefined): VoiceInfo | undefined {
  const key = (name ?? '').trim().toLowerCase();
  if (!key) return undefined;
  return byLowerName.get(key) ?? remoteExtras.find((v) => v.name.toLowerCase() === key);
}

/** Nome canônico de uma voz válida; vozes desconhecidas caem para a padrão (evita erro 400 no Gemini). */
export function resolveVoiceName(name: string | null | undefined): string {
  return findVoice(name)?.name ?? DEFAULT_VOICE;
}

/** Descrição em PT-BR para uma voz nova do catálogo (só temos metadados em inglês). */
function describeRemoteVoice(gender: string | undefined, pitch: string | undefined): string {
  const g = (gender ?? '').toLowerCase();
  const genderText = g === 'female' ? 'Feminina' : g === 'male' ? 'Masculina' : g === 'neutral' ? 'Neutra' : 'Voz';
  const p = (pitch ?? '').toLowerCase();
  const pitchText = p === 'low' ? ', de timbre grave' : p === 'high' ? ', de timbre agudo' : p === 'medium' ? ', de timbre médio' : '';
  return `${genderText}${pitchText} — voz nova do catálogo do Gemini.`;
}

async function fetchRemoteVoices(): Promise<void> {
  const ai = getClient();
  if (!ai) return;
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Tempo esgotado ao listar vozes.')), REMOTE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const response = await Promise.race([
      ai.voices.list({ type: ['prebuilt'], page_size: 200 }, { timeout_ms: REMOTE_TIMEOUT_MS }),
      timeout,
    ]);
    const extras: VoiceInfo[] = [];
    const seen = new Set<string>();
    for (const voice of response.voices ?? []) {
      if (voice.type && voice.type !== 'prebuilt') continue;
      const raw = (voice.display_name || voice.id || '').trim().replace(/^voices\//, '');
      // As vozes do Gemini têm nomes de estrelas de uma palavra; outros formatos (ex.: vozes do
      // Cloud TTS) não funcionam com prebuiltVoiceConfig.
      if (!/^[A-Za-z]{3,20}$/.test(raw)) continue;
      const name = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
      const key = name.toLowerCase();
      if (byLowerName.has(key) || seen.has(key)) continue;
      seen.add(key);
      extras.push({ name, description: describeRemoteVoice(voice.gender, voice.pitch) });
    }
    remoteExtras = extras;
    remoteFetchedAt = Date.now();
  } catch {
    // O catálogo remoto é opcional: a lista fixa continua valendo.
    remoteFailedAt = Date.now();
  }
}

/**
 * Lista de vozes para a interface: a lista fixa (descrições em PT-BR) mais as vozes novas do
 * catálogo oficial, quando disponível. Nunca lança.
 */
export async function listVoices(opts: { force?: boolean } = {}): Promise<VoiceInfo[]> {
  if (!config.mock && getClient()) {
    const now = Date.now();
    const fresh = remoteFetchedAt > 0 && now - remoteFetchedAt < REMOTE_TTL_MS;
    const recentlyFailed = remoteFailedAt > 0 && now - remoteFailedAt < REMOTE_FAILURE_TTL_MS;
    if (opts.force || (!fresh && !recentlyFailed)) {
      remoteInflight ??= fetchRemoteVoices().finally(() => {
        remoteInflight = null;
      });
      await remoteInflight;
    }
  }
  return [...GEMINI_VOICES, ...remoteExtras].map((v) => ({ ...v }));
}
