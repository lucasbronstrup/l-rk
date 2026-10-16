import type { ChatMessage, ChatStreamEvent, Settings, ToolCallInfo } from '@shared/types';

export type EngineErrorCode = NonNullable<Extract<ChatStreamEvent, { type: 'error' }>['code']>;

/** Erro de motor com código conhecido pela interface e mensagem em PT-BR. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** true quando vale tentar outro motor (nada foi transmitido ainda). */
  readonly canFallback: boolean;
  /** Texto parcial já transmitido antes da falha. */
  readonly partial: string;
  constructor(code: EngineErrorCode, message: string, opts: { canFallback?: boolean; partial?: string } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.canFallback = opts.canFallback ?? false;
    this.partial = opts.partial ?? '';
  }
}

export interface TurnInput {
  conversationId: string;
  userText: string;
  /** Mensagens anteriores da conversa (sem a mensagem atual), em ordem cronológica. */
  history: ChatMessage[];
  settings: Settings;
  signal: AbortSignal;
  onThought(text: string): void;
  onToken(text: string): void;
  onTool(call: ToolCallInfo): void;
}

export interface TurnOutput {
  content: string;
  thoughts: string;
  toolCalls: ToolCallInfo[];
  model: string;
}
