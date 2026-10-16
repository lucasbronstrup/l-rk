/**
 * Cérebro da edição web: escolhe o motor de IA para cada turno.
 *  a) Gemini direto do navegador, quando há chave salva e o domínio do Google é alcançável;
 *  b) Claude pela capacidade "sample" do claude.ai (página publicada como Artifact);
 *  c) nenhum → erro 'no_api_key' (a interface convida a colar a chave).
 * Se o Gemini falhar por rede/CSP, fica marcado como inacessível nesta página e o turno segue no Claude.
 */
import type { ModelRole } from '@shared/types';
import { CLAUDE_MODEL_LABEL, claudeStatus, loadSample, onClaudeChange, runClaudeTurn } from './claude';
import { getApiKey, getSettings, onApiKeyChange } from './db';
import { EngineError, type TurnInput, type TurnOutput } from './engine-types';
import { GeminiUnreachable, TTS_MODELS, chatModelOrder, isGeminiUnreachable, resetGeminiReachability, runGeminiTurn } from './gemini';
import { isAbort } from './util';

export { EngineError } from './engine-types';
export type { TurnInput, TurnOutput } from './engine-types';

export type EngineState = 'gemini' | 'claude' | 'pending' | 'none';

export const NO_ENGINE_MESSAGE = 'Cole sua chave gratuita do Google AI Studio em Configurações → Inteligência para eu ganhar voz e cérebro.';

const listeners = new Set<(s: EngineState) => void>();
let lastState: EngineState | null = null;

function emitIfChanged(): void {
  const s = engineState();
  if (s === lastState) return;
  lastState = s;
  listeners.forEach((fn) => fn(s));
}

/** Avisa quando o motor disponível muda (chave salva, Claude resolvido, Gemini bloqueado…). */
export function onEngineChange(fn: (s: EngineState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

onClaudeChange(emitIfChanged);
onApiKeyChange(() => {
  // Chave nova: dá ao Gemini uma nova chance de ser alcançado.
  resetGeminiReachability();
  emitIfChanged();
});

/** Começa a resolver o Claude cedo (sem pedir nada ao visitante). */
export function warmUpEngines(): void {
  void loadSample();
  emitIfChanged();
}

export function geminiKey(): string | null {
  const key = getApiKey();
  return key && !isGeminiUnreachable() ? key : null;
}

export function engineState(): EngineState {
  if (geminiKey()) return 'gemini';
  const c = claudeStatus();
  if (c === 'ready') return 'claude';
  if (c === 'pending') return 'pending';
  return 'none';
}

/** Resolve o motor, esperando a capacidade do claude.ai por até `waitMs`. */
export async function resolveEngine(waitMs = 10_500): Promise<'gemini' | 'claude' | null> {
  if (geminiKey()) return 'gemini';
  if (claudeStatus() === 'pending' || claudeStatus() === 'unavailable') {
    await Promise.race([loadSample(), new Promise((r) => setTimeout(r, waitMs))]);
  }
  const s = engineState();
  return s === 'gemini' || s === 'claude' ? s : null;
}

export function activeModels(): Partial<Record<ModelRole, string>> {
  const s = getSettings();
  const state = engineState();
  if (state === 'gemini') {
    return {
      chat: chatModelOrder(s.models.chat)[0],
      fast: 'gemini-3.5-flash-lite',
      tts: s.models.tts || TTS_MODELS[0],
    };
  }
  if (state === 'claude') return { chat: CLAUDE_MODEL_LABEL };
  return {};
}

export function plannedModel(): string {
  const state = engineState();
  if (state === 'gemini') return chatModelOrder(getSettings().models.chat)[0];
  if (state === 'claude') return CLAUDE_MODEL_LABEL;
  return 'nenhum';
}

/** Executa um turno completo no melhor motor disponível. Lança EngineError ou AbortError. */
export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  const key = geminiKey();
  if (key) {
    try {
      return await runGeminiTurn({ ...input, key });
    } catch (e) {
      if (isAbort(e) || input.signal.aborted) throw e;
      if (e instanceof GeminiUnreachable) {
        console.info('[Lärk web] Gemini inacessível nesta página (rede ou política de segurança). Usando o Claude.');
        emitIfChanged();
      } else if (e instanceof EngineError && e.canFallback && !e.partial) {
        const sample = await loadSample();
        if (!sample || claudeStatus() !== 'ready') throw e;
        console.info('[Lärk web] Gemini falhou (%s); tentando o Claude.', e.message);
      } else {
        throw e;
      }
    }
  }
  const sample = await loadSample();
  if (sample && claudeStatus() === 'ready') return runClaudeTurn({ ...input, sample });
  throw new EngineError('no_api_key', NO_ENGINE_MESSAGE);
}
