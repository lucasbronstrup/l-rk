import { create } from 'zustand';
import { usePrefs } from '@/store/prefs';
import { useUi } from '@/store/ui';
import { getAudioContext, resumeAudioContext } from './context';
import { LEVEL_PRIORITY, setLevelSource } from './levels';
import { analyserReader } from './pcm';

/**
 * Voz do Lärk fora do modo Live.
 * Gemini TTS (POST /api/tts → WAV) com fila sequencial, divisão de textos longos e pré-busca;
 * na falta dele, a melhor voz pt-BR do navegador (speechSynthesis).
 */

/** Estado observável da fala (para botões "reproduzir/parar" por mensagem). */
export const useSpeech = create<{ speaking: boolean; currentKey: string | null }>(() => ({
  speaking: false,
  currentKey: null,
}));

export interface SpeakOptions {
  /** Identificador do conteúdo falado (ex.: id da mensagem) — exposto em useSpeech.currentKey. */
  key?: string;
  /** Interrompe o que estiver sendo falado antes de começar. */
  interrupt?: boolean;
}

interface SpeechJob {
  text: string;
  key: string | null;
  resolve: () => void;
}

const LONG_TEXT = 900;
const FIRST_BLOCK = 380;
const BROWSER_PIECE = 220;
const LEVEL_KEY = 'speech';

const queue: SpeechJob[] = [];
let running = false;
let generation = 0;
let fetchAbort: AbortController | null = null;
let stopCurrent: (() => void) | null = null;
/** Após um 204 do /api/tts, evita novas tentativas por um tempo (sem chave, modo demo, cota). */
let ttsUnavailableUntil = 0;

// ─── API pública ──────────────────────────────────────────────────────────

/** Fala o texto (markdown é limpo antes). A promessa resolve quando termina ou é cancelada. */
export function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const clean = toSpeakable(text);
  if (!clean) return Promise.resolve();
  if (opts.interrupt) stopSpeaking();
  return new Promise<void>((resolve) => {
    queue.push({ text: clean, key: opts.key ?? null, resolve });
    void pump();
  });
}

/** Cancela imediatamente a fala atual e tudo o que estava na fila. */
export function stopSpeaking(): void {
  generation++;
  const pending = queue.splice(0, queue.length);
  pending.forEach((j) => j.resolve());
  fetchAbort?.abort();
  fetchAbort = null;
  const stop = stopCurrent;
  stopCurrent = null;
  stop?.();
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignorado */
    }
  }
  setLevelSource(LEVEL_KEY, null);
  useSpeech.setState({ speaking: false, currentKey: null });
  releaseOrb();
}

export function isSpeaking(): boolean {
  return useSpeech.getState().speaking;
}

/** Converte markdown em texto natural para fala: sem código, URLs, tabelas ou símbolos. */
export function toSpeakable(input: string): string {
  if (!input) return '';
  let s = input.replace(/\r\n?/g, '\n');
  s = s.replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '');
  s = s.replace(/```[\s\S]*?(```|$)/g, '\n');
  s = s.replace(/~~~[\s\S]*?(~~~|$)/g, '\n');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1');
  s = s.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, '');
  s = s.replace(/<https?:\/\/[^>]+>/gi, ' ');
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s)]+?(?=[.,;:!?]*(?:\s|$|\)))/gi, ' ');
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ');
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, (_m, h: string) => endSentence(h));
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/gm, (_m, item: string) => endSentence(item, ';'));
  s = s.replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*(?::?-{3,}:?)?[ \t]*$/gm, '');
  s = s.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) =>
    endSentence(row.split('|').map((c) => c.trim()).filter(Boolean).join(', ')),
  );
  s = s.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1$2');
  s = s.replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?=\W|$)/g, '$1$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  s = s.replace(/[*#>|`]+/g, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/ +([.,;:!?])/g, '$1').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Lista as vozes pt do navegador (para a tela de configurações). */
export function listPortugueseVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices().filter((v) => normLang(v.lang).startsWith('pt'));
}

// ─── Fila ─────────────────────────────────────────────────────────────────

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  const gen = generation;
  try {
    while (queue.length > 0 && gen === generation) {
      const job = queue.shift()!;
      useSpeech.setState({ speaking: true, currentKey: job.key });
      try {
        await playJob(job.text, gen);
      } catch (e) {
        console.warn('[Lärk] Falha ao falar:', e);
      } finally {
        job.resolve();
      }
    }
  } finally {
    running = false;
    if (gen === generation) {
      setLevelSource(LEVEL_KEY, null);
      useSpeech.setState({ speaking: false, currentKey: null });
      releaseOrb();
    } else if (queue.length > 0) {
      void pump();
    }
  }
}

async function playJob(text: string, gen: number): Promise<void> {
  const blocks = text.length > LONG_TEXT ? splitIntoBlocks(text) : [text];
  const abort = new AbortController();
  fetchAbort = abort;
  let useBrowser = false;
  let next: Promise<AudioBuffer | null> | null = fetchSpeech(blocks[0], abort.signal);

  for (let i = 0; i < blocks.length; i++) {
    if (gen !== generation) return;
    const audio = useBrowser ? null : await next;
    if (gen !== generation) return;
    // Pré-busca o próximo bloco enquanto este toca.
    next = !useBrowser && i + 1 < blocks.length ? fetchSpeech(blocks[i + 1], abort.signal) : null;
    if (audio) {
      await playBuffer(audio, gen);
    } else {
      // Uma vez no navegador, ficamos nele: trocar de voz no meio soa estranho.
      useBrowser = true;
      next?.catch(() => null);
      next = null;
      await speakWithBrowser(blocks[i], gen);
    }
  }
  if (fetchAbort === abort) fetchAbort = null;
}

/** Divide textos longos por parágrafos e frases; o primeiro bloco é menor para começar rápido. */
export function splitIntoBlocks(text: string): string[] {
  const units: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.replace(/\s*\n\s*/g, ' ').trim();
    if (!p) continue;
    if (p.length <= LONG_TEXT) units.push(p);
    else units.push(...splitSentences(p, LONG_TEXT));
  }
  const blocks: string[] = [];
  let cur = '';
  for (const u of units) {
    const limit = blocks.length === 0 ? FIRST_BLOCK : LONG_TEXT;
    if (!cur) cur = u;
    else if (cur.length + 2 + u.length <= limit) cur += `\n\n${u}`;
    else {
      blocks.push(cur);
      cur = u;
    }
  }
  if (cur) blocks.push(cur);
  // Se o primeiro bloco ficou grande demais, quebre-o por frases para reduzir a espera inicial.
  if (blocks.length && blocks[0].length > FIRST_BLOCK * 1.6) {
    const [head, ...rest] = splitSentences(blocks[0], FIRST_BLOCK);
    const tail = rest.join(' ');
    blocks.splice(0, 1, head, ...(tail ? [tail] : []));
  }
  return blocks;
}

/** Quebra em frases agrupadas até `max` caracteres (cai para vírgulas/espaços se preciso). */
function splitSentences(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["'”»)]*|$)\s*/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  const pushPiece = (piece: string) => {
    if (piece.length <= max) {
      if (!cur) cur = piece;
      else if (cur.length + 1 + piece.length <= max) cur += ` ${piece}`;
      else {
        out.push(cur);
        cur = piece;
      }
      return;
    }
    // Frase gigante: divide por vírgulas, depois por palavras.
    const parts = piece.split(/(?<=[,;:])\s+/);
    if (parts.length > 1) return parts.forEach((p) => pushPiece(p.trim()));
    const words = piece.split(/\s+/);
    let acc = '';
    for (const w of words) {
      if ((acc + ' ' + w).trim().length > max && acc) {
        pushPiece(acc.trim());
        acc = w;
      } else acc = `${acc} ${w}`;
    }
    if (acc.trim()) pushPiece(acc.trim());
  };
  for (const s of sentences) {
    const t = s.trim();
    if (t) pushPiece(t);
  }
  if (cur) out.push(cur);
  return out;
}

// ─── Gemini TTS ───────────────────────────────────────────────────────────

async function fetchSpeech(text: string, signal: AbortSignal): Promise<AudioBuffer | null> {
  if (Date.now() < ttsUnavailableUntil) return null;
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (res.status === 204) {
      ttsUnavailableUntil = Date.now() + 60_000;
      return null;
    }
    if (!res.ok) return null;
    const data = await res.arrayBuffer();
    if (data.byteLength < 64) return null;
    const ac = getAudioContext();
    if (!ac) return null;
    return await ac.decodeAudioData(data);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) console.warn('[Lärk] TTS indisponível:', e);
    return null;
  }
}

async function playBuffer(buffer: AudioBuffer, gen: number): Promise<void> {
  const ac = await resumeAudioContext();
  if (!ac || gen !== generation) return;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const gain = ac.createGain();
  gain.gain.value = clampVolume(usePrefs.getState().volume);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.3;
  src.connect(gain);
  gain.connect(analyser);
  analyser.connect(ac.destination);

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (stopCurrent === stop) stopCurrent = null;
      try {
        src.disconnect();
        gain.disconnect();
        analyser.disconnect();
      } catch {
        /* já desconectado */
      }
      resolve();
    };
    const stop = () => {
      try {
        src.stop();
      } catch {
        /* não iniciado */
      }
      finish();
    };
    src.onended = finish;
    stopCurrent = stop;
    setLevelSource(LEVEL_KEY, analyserReader(analyser), LEVEL_PRIORITY.speech);
    claimOrb();
    try {
      src.start();
    } catch {
      finish();
    }
  });
}

// ─── Reserva: voz do navegador ────────────────────────────────────────────

let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  if (!voicesReady) {
    const p = new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const done = () => {
        synth.removeEventListener('voiceschanged', done);
        resolve(synth.getVoices());
      };
      synth.addEventListener('voiceschanged', done);
      setTimeout(done, 1500);
    }).then((v) => {
      // Lista vazia: permite tentar de novo na próxima fala.
      if (!v.length) voicesReady = null;
      return v;
    });
    voicesReady = p;
    return p;
  }
  return voicesReady;
}

function normLang(lang: string): string {
  return lang.replace('_', '-').toLowerCase();
}

/** Escolhe a voz pt-BR mais natural disponível (ou a preferida do usuário). */
export function pickFallbackVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const preferred = usePrefs.getState().fallbackVoiceURI;
  if (preferred) {
    const v = voices.find((x) => x.voiceURI === preferred);
    if (v) return v;
  }
  const ptBR = voices.filter((v) => normLang(v.lang) === 'pt-br');
  const pool = ptBR.length ? ptBR : voices.filter((v) => normLang(v.lang).startsWith('pt'));
  if (!pool.length) return null;
  const score = (v: SpeechSynthesisVoice) => {
    let s = 0;
    if (/natural|neural|online/i.test(v.name)) s += 4;
    if (/francisca|antonio|ant[oô]nio|thalita/i.test(v.name)) s += 3;
    if (/google/i.test(v.name)) s += 2;
    if (!v.localService) s += 1;
    return s;
  };
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? pool[0];
}

async function speakWithBrowser(text: string, gen: number): Promise<void> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  const voices = await loadVoices();
  if (gen !== generation) return;
  const voice = pickFallbackVoice(voices);
  // O Chrome corta falas muito longas; frases curtas são mais seguras.
  const pieces = splitSentences(text.replace(/\s*\n+\s*/g, ' '), BROWSER_PIECE);

  let pulse = 0;
  const started = performance.now();
  setLevelSource(
    LEVEL_KEY,
    () => {
      pulse *= 0.9;
      const t = (performance.now() - started) / 1000;
      const osc = 0.26 + 0.12 * Math.sin(t * 11) + 0.07 * Math.sin(t * 27 + 1.3);
      return Math.min(1, Math.max(0, osc + pulse * 0.45));
    },
    LEVEL_PRIORITY.speech,
  );
  claimOrb();

  for (const piece of pieces) {
    if (gen !== generation) return;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(piece);
      u.lang = voice?.lang ?? 'pt-BR';
      if (voice) u.voice = voice;
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = clampVolume(usePrefs.getState().volume);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (stopCurrent === stop) stopCurrent = null;
        resolve();
      };
      const stop = () => {
        synth.cancel();
        done();
      };
      u.onboundary = () => {
        pulse = 1;
      };
      u.onend = done;
      u.onerror = done;
      // Segurança: alguns navegadores não disparam onend.
      const guard = setTimeout(done, 4000 + piece.length * 120);
      stopCurrent = stop;
      synth.speak(u);
    });
  }
}

// ─── Orbe ─────────────────────────────────────────────────────────────────

function claimOrb() {
  const ui = useUi.getState();
  if (ui.orbState !== 'speaking') ui.setOrbState('speaking');
}

function releaseOrb() {
  const ui = useUi.getState();
  if (ui.orbState === 'speaking') ui.setOrbState('idle');
}

function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

function endSentence(text: string, mark = '.'): string {
  const t = text.trim();
  if (!t) return '';
  return /[.!?…:;,]$/.test(t) ? t : `${t}${mark}`;
}
