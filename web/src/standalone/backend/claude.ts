/**
 * Claude pela capacidade "sample" do claude.ai (quando a página está publicada como Artifact).
 * O uso consome a conta do próprio visitante; a primeira chamada pede consentimento.
 * Fora do claude.ai, `window.claude` não existe e este motor fica indisponível.
 */
import type { ChatMessage, ToolCallInfo } from '@shared/types';
import { EngineError, type TurnInput, type TurnOutput } from './engine-types';
import { buildSystemInstruction } from './persona';
import { LOCAL_TOOLS, runTool } from './tools';
import { abortError, isRecord, truncate } from './util';

// ─── Tipos mínimos do contrato `sample` ──────────────────────────────────

interface SampleMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SampleTool {
  name: string;
  description: string;
  inputSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  execute(input: Record<string, unknown>, context: { signal: AbortSignal }): unknown;
}

interface SampleOptions {
  onText?: (u: { text: string; delta: string }) => void;
  signal?: AbortSignal;
  tools?: SampleTool[];
  modelTier?: 'quick' | 'default' | 'complex';
  cache?: boolean;
}

interface SampleLimits {
  maxPromptBytes: number;
  tools?: { maxCount: number };
}

export type SampleFn = ((input: string | SampleMessage[], options?: SampleOptions) => Promise<{ text: string; truncated: boolean }>) & {
  limits?: () => Promise<SampleLimits>;
};

interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

// ─── Disponibilidade ─────────────────────────────────────────────────────

const USE_TIMEOUT_MS = 10_500;

let samplePromise: Promise<SampleFn | null> | null = null;
let resolved: SampleFn | null | undefined;
/** O visitante recusou (ou a conta não permite) — não insistimos nesta página. */
let blockedReason: string | null = null;

const listeners = new Set<() => void>();
export function onClaudeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn());

/** Obtém a função `sample` (memorizada). Resolve null fora do claude.ai ou após ~10 s sem resposta. */
export function loadSample(): Promise<SampleFn | null> {
  if (!samplePromise) {
    samplePromise = (async () => {
      const runtime = (window as unknown as { claude?: Partial<ClaudeRuntime> }).claude;
      if (!runtime || typeof runtime.use !== 'function') return null;
      try {
        const value = await Promise.race([
          runtime.use('sample'),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), USE_TIMEOUT_MS)),
        ]);
        return typeof value === 'function' ? (value as SampleFn) : null;
      } catch {
        return null;
      }
    })().then((fn) => {
      resolved = fn;
      notify();
      return fn;
    });
  }
  return samplePromise;
}

export type ClaudeStatus = 'pending' | 'ready' | 'unavailable';

export function claudeStatus(): ClaudeStatus {
  if (blockedReason) return 'unavailable';
  if (resolved === undefined) return samplePromise ? 'pending' : 'unavailable';
  return resolved ? 'ready' : 'unavailable';
}

export const CLAUDE_MODEL_LABEL = 'Claude (claude.ai)';

// ─── Turno ───────────────────────────────────────────────────────────────

interface SampleRejection {
  code?: string;
  message?: string;
  text?: string;
}

function toTurns(history: ChatMessage[]): SampleMessage[] {
  const out: SampleMessage[] = [];
  for (const m of history.slice(-24)) {
    if (m.role === 'system' || !m.content.trim()) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', content: truncate(m.content, 4000) });
  }
  return out;
}

let limitsCache: Promise<SampleLimits | null> | null = null;
function getLimits(sample: SampleFn): Promise<SampleLimits | null> {
  if (!limitsCache) {
    limitsCache = typeof sample.limits === 'function' ? sample.limits().catch(() => null) : Promise.resolve(null);
  }
  return limitsCache;
}

function rejectionToError(e: SampleRejection, partial: string): EngineError {
  const code = e.code ?? 'upstream_error';
  switch (code) {
    case 'not_granted':
      blockedReason = code;
      notify();
      return new EngineError(
        'provider',
        'Você não autorizou o Lärk a usar o Claude nesta página. Para conversar, permita o uso do Claude no menu de permissões do Artifact (e recarregue), ou cole uma chave gratuita do Google AI Studio em Configurações → Inteligência.',
        { partial },
      );
    case 'sampling_disabled':
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed':
      blockedReason = code;
      notify();
      return new EngineError(
        'provider',
        'O Claude não está disponível para esta conta ou nesta visualização. Cole uma chave gratuita do Google AI Studio em Configurações → Inteligência para eu continuar pensando.',
        { partial },
      );
    case 'rate_limited':
      return new EngineError('provider', 'Muitas mensagens em sequência: o Claude pediu uma pausa. Respire, aguarde alguns instantes e tente de novo.', { partial });
    case 'session_expired':
      return new EngineError('provider', 'Sua sessão no claude.ai expirou. Entre novamente e recarregue a página.', { partial });
    case 'refused':
      return new EngineError('provider', 'O Claude preferiu não responder a isso. Que tal reformular a pergunta?', { partial: '' });
    case 'prompt_too_large':
      return new EngineError('provider', 'A conversa ficou longa demais para uma única leitura. Comece uma nova conversa e seguimos de lá.', { partial });
    case 'empty_completion':
      return new EngineError('provider', 'Fiquei sem palavras desta vez. Tente perguntar de outro jeito.', { partial });
    default:
      return new EngineError('provider', 'O Claude não respondeu agora. Tente novamente em instantes.', { partial });
  }
}

export async function runClaudeTurn(input: TurnInput & { sample: SampleFn }): Promise<TurnOutput> {
  const { sample, signal } = input;
  const limits = await getLimits(sample);
  let toolsOk = Boolean(limits?.tools && limits.tools.maxCount > 0);
  const toolCalls: ToolCallInfo[] = [];

  const makeTools = (): SampleTool[] =>
    LOCAL_TOOLS.slice(0, limits?.tools?.maxCount ?? LOCAL_TOOLS.length).map((t) => ({
      name: t.name,
      description: truncate(t.description, 1000),
      inputSchema: t.parameters,
      execute: async (args: Record<string, unknown>, context: { signal: AbortSignal }) => {
        if (signal.aborted || context.signal.aborted) throw new Error('Cancelado pelo usuário.');
        const result = await runTool(t.name, isRecord(args) ? args : {}, {
          conversationId: input.conversationId,
          emit: (call) => {
            const i = toolCalls.findIndex((c) => c.id === call.id);
            if (i >= 0) toolCalls[i] = call;
            else toolCalls.push(call);
            input.onTool(call);
          },
        });
        if (!result.ok) throw new Error(String(result.output.error ?? 'Falha na ferramenta.'));
        return result.output;
      },
    }));

  const attempt = async (withTools: boolean): Promise<TurnOutput> => {
    const system = buildSystemInstruction(input.settings, { conversationId: input.conversationId, query: input.userText, toolsAvailable: withTools });
    const turns: SampleMessage[] = [
      {
        role: 'user',
        content:
          'INSTRUÇÕES DO APLICATIVO LÄRK (configuração do assistente — não são falas do usuário):\n\n' +
          system +
          '\n\n---\nA conversa com o usuário começa abaixo. Responda sempre como o Lärk, em português do Brasil.',
      },
      ...toTurns(input.history),
      { role: 'user', content: input.userText },
    ];
    let shown = '';
    try {
      const result = await sample(turns, {
        cache: false,
        signal,
        modelTier: 'quick',
        ...(withTools ? { tools: makeTools() } : {}),
        onText: ({ text, delta }) => {
          const add = text.startsWith(shown) ? text.slice(shown.length) : delta;
          shown = text;
          if (add) input.onToken(add);
        },
      });
      const content = (result.text || shown).trim();
      if (!content) throw new EngineError('provider', 'Fiquei sem palavras desta vez. Tente perguntar de outro jeito.');
      return { content, thoughts: '', toolCalls, model: CLAUDE_MODEL_LABEL };
    } catch (e) {
      if (e instanceof EngineError) throw e;
      const rej: SampleRejection = isRecord(e) ? (e as SampleRejection) : {};
      if (rej.code === 'cancelled' || signal.aborted) throw abortError();
      if (rej.code === 'tools_unavailable' && withTools && !shown) {
        toolsOk = false;
        return attempt(false);
      }
      throw rejectionToError(rej, rej.text ?? shown);
    }
  };

  return attempt(toolsOk);
}
