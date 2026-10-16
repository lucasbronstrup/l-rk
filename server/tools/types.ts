import type { ToolCallInfo, ToolRisk } from '../../shared/types.js';

/** JSON Schema (subconjunto) usado em parametersJsonSchema do Gemini. */
export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolContext {
  conversationId: string;
  /** 'text' = chat; 'voice' = sessão Live. */
  mode: 'text' | 'voice';
  /** Notifica a interface sobre mudança de status da chamada (running/awaiting_approval/...). */
  emit: (call: ToolCallInfo) => void;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Conteúdo devolvido ao modelo (vira functionResponse.response). */
  output: Record<string, unknown>;
  /** Resumo curto em PT-BR para a interface. */
  summary: string;
  /** Opcional: partes inline extras (ex.: imagem de screenshot) para o modelo analisar. */
  inlineData?: { mimeType: string; data: string }[];
}

export interface ToolDefinition<A = Record<string, any>> {
  name: string;
  /** Rótulo curto em PT-BR para a interface (ex.: "Buscando arquivos"). */
  label: string;
  description: string;
  parameters: JsonSchema;
  risk: ToolRisk;
  /** Descrição humana da ação para o pedido de aprovação. */
  describe?: (args: A) => string;
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>;
}
