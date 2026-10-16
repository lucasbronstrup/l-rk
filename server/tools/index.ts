/**
 * Registro e execução das ferramentas do Lärk.
 *
 * - `getAllTools()` junta memória + computador + web + utilitários (as do computador somem quando o
 *   acesso está desligado nas configurações).
 * - `getToolDeclarations()` gera as FunctionDeclarations do Gemini.
 * - `runTool()` aplica a política de aprovação, o timeout e a captura de erros, avisando a interface
 *   a cada mudança de status.
 */
import type { FunctionDeclaration } from '@google/genai';
import { getSettings } from '../memory/settings.js';
import { newId } from '../lib/ids.js';
import { memoryTools } from './memory-tools.js';
import { requestApprovalDetailed, DEFAULT_APPROVAL_TIMEOUT_MS } from './approvals.js';
import { fileTools } from './files.js';
import { shellTools } from './shell.js';
import { systemTools } from './system.js';
import { desktopTools } from './desktop.js';
import { webTools } from './web.js';
import { utilityTools, type ToolSpec } from './utility.js';
import type { Settings, ToolCallInfo, ToolRisk } from '../../shared/types.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

export type { ToolSpec } from './utility.js';

const DEFAULT_TIMEOUT_MS = 60_000;
/** Limite do conteúdo devolvido ao modelo por chamada (proteção contra saídas enormes). */
const MAX_OUTPUT_CHARS = 150_000;

/** Ferramentas do computador/web/utilitários (fonte única). */
const SYSTEM_TOOLS: ToolSpec[] = [...utilityTools, ...webTools, ...fileTools, ...shellTools, ...systemTools, ...desktopTools];

function isSpec(def: ToolDefinition): def is ToolSpec {
  return typeof (def as Partial<ToolSpec>).group === 'string';
}

function currentSettings(): Settings | null {
  try {
    return getSettings();
  } catch {
    return null;
  }
}

/** Todas as ferramentas disponíveis agora (memória sempre; computador só se habilitado). */
export function getAllTools(): ToolDefinition[] {
  const computerEnabled = currentSettings()?.computer.enabled ?? true;
  const system = SYSTEM_TOOLS.filter((t) => computerEnabled || t.group !== 'computer');
  const names = new Set<string>();
  const all: ToolDefinition[] = [];
  for (const tool of [...(memoryTools as ToolDefinition[]), ...(system as ToolDefinition[])]) {
    if (names.has(tool.name)) continue;
    names.add(tool.name);
    all.push(tool);
  }
  return all;
}

/** Busca uma ferramenta pelo nome entre as disponíveis agora. */
export function getTool(name: string): ToolDefinition | undefined {
  return getAllTools().find((t) => t.name === name);
}

/** true se a ferramenta existe mas está desligada (acesso ao computador desativado). */
function isDisabledComputerTool(name: string): boolean {
  return SYSTEM_TOOLS.some((t) => t.name === name && t.group === 'computer');
}

/** Declarações no formato do @google/genai (`parametersJsonSchema`). */
export function getToolDeclarations(mode: 'text' | 'voice'): FunctionDeclaration[] {
  return getAllTools().map((tool) => ({
    name: tool.name,
    description:
      mode === 'voice' && tool.risk !== 'safe'
        ? `${tool.description} (Na conversa por voz, avise em voz alta antes: o usuário pode precisar aprovar na tela.)`
        : tool.description,
    parametersJsonSchema: tool.parameters,
  }));
}

/** Risco efetivo da chamada (ferramentas podem elevar o risco conforme os argumentos). */
export function effectiveRisk(def: ToolDefinition, args: Record<string, unknown>): ToolRisk {
  if (isSpec(def) && def.riskFor) {
    try {
      return def.riskFor(args);
    } catch {
      return def.risk;
    }
  }
  return def.risk;
}

/** Decide se a chamada precisa de aprovação conforme o modo escolhido pelo usuário. */
export function needsApproval(risk: ToolRisk, mode: Settings['computer']['approvalMode']): boolean {
  if (risk === 'safe') return false;
  if (mode === 'never') return false;
  if (mode === 'dangerous-only') return risk === 'dangerous';
  return true;
}

function timeoutFor(def: ToolDefinition, args: Record<string, unknown>): number {
  if (!isSpec(def) || def.timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  try {
    const ms = typeof def.timeoutMs === 'function' ? def.timeoutMs(args) : def.timeoutMs;
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}

/** Cópia dos argumentos para exibição (textos longos encurtados). */
function displayArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 2000) {
      out[key] = `${value.slice(0, 2000)}… (+${(value.length - 2000).toLocaleString('pt-BR')} caracteres)`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function shortSummary(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Garante que a saída é serializável e de tamanho razoável para o modelo. */
function sanitizeOutput(output: Record<string, unknown>): Record<string, unknown> {
  let json: string;
  try {
    json = JSON.stringify(output ?? {});
  } catch {
    return { error: 'A ferramenta devolveu um resultado que não pôde ser serializado.' };
  }
  if (json.length <= MAX_OUTPUT_CHARS) return JSON.parse(json) as Record<string, unknown>;
  return {
    truncated: true,
    note: 'Resultado grande demais; mostrando apenas o início. Refine a chamada (limites, offset, filtros).',
    partial: json.slice(0, MAX_OUTPUT_CHARS),
  };
}

/** Executa com timeout, abortando o sinal repassado à ferramenta quando o tempo acaba. */
async function executeWithTimeout(
  def: ToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onParentAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      const error = new Error(`A ação excedeu o tempo limite de ${seconds} s e foi interrompida.`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    onParentAbort = () => {
      const error = new Error('A ação foi cancelada.');
      controller.abort(error);
      reject(error);
    };
    if (ctx.signal?.aborted) onParentAbort();
    else ctx.signal?.addEventListener('abort', onParentAbort, { once: true });
  });
  try {
    return await Promise.race([def.execute(args, { ...ctx, signal: controller.signal }), guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onParentAbort) ctx.signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Executa uma ferramenta pedida pelo modelo: valida, pede aprovação se preciso, aplica timeout e
 * captura erros. Nunca lança: falhas viram `{ error }` na saída (o modelo explica ao usuário).
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  callId?: string,
): Promise<{ call: ToolCallInfo; result: ToolResult }> {
  const safeArgs: Record<string, unknown> = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const def = getTool(name);
  const call: ToolCallInfo = {
    id: callId || newId(),
    name,
    label: def?.label ?? name,
    args: displayArgs(safeArgs),
    status: 'running',
    risk: def ? effectiveRisk(def, safeArgs) : 'safe',
  };
  const emit = () => {
    try {
      ctx.emit({ ...call, args: { ...call.args } });
    } catch {
      // A interface pode ter desconectado; a execução segue.
    }
  };
  const finish = (status: ToolCallInfo['status'], result: ToolResult) => {
    call.status = status;
    call.summary = shortSummary(result.summary);
    emit();
    return { call: { ...call }, result };
  };

  if (!def) {
    const message = isDisabledComputerTool(name)
      ? 'O acesso ao computador está desativado nas configurações do Lärk.'
      : `A ferramenta "${name}" não existe.`;
    return finish('error', { output: { error: message }, summary: message });
  }
  if (ctx.signal?.aborted) {
    return finish('error', { output: { error: 'A ação foi cancelada antes de começar.' }, summary: 'Cancelada' });
  }

  const approvalMode = currentSettings()?.computer.approvalMode ?? 'ask';
  if (needsApproval(call.risk, approvalMode)) {
    call.status = 'awaiting_approval';
    emit();
    let description: string;
    try {
      description = def.describe?.(safeArgs) ?? `${def.label}: ${JSON.stringify(call.args).slice(0, 500)}`;
    } catch {
      description = `${def.label}: ${JSON.stringify(call.args).slice(0, 500)}`;
    }
    const { outcome } = await requestApprovalDetailed(
      { toolName: def.name, label: def.label, risk: call.risk, description, args: call.args },
      DEFAULT_APPROVAL_TIMEOUT_MS,
      ctx.signal,
    );
    if (outcome !== 'approved') {
      const message =
        outcome === 'timeout'
          ? 'Usuário não respondeu ao pedido de aprovação a tempo; a ação não foi executada.'
          : outcome === 'cancelled'
            ? 'A conversa foi interrompida antes da aprovação; a ação não foi executada.'
            : 'Usuário negou a ação.';
      return finish('denied', {
        output: { error: message },
        summary: outcome === 'timeout' ? 'Sem resposta — não executado' : outcome === 'cancelled' ? 'Cancelado' : 'Ação negada',
      });
    }
  }

  call.status = 'running';
  emit();
  try {
    const result = await executeWithTimeout(def, safeArgs, ctx, timeoutFor(def, safeArgs));
    const sanitized: ToolResult = {
      output: sanitizeOutput(result.output),
      summary: result.summary || 'Concluído',
      ...(result.inlineData?.length ? { inlineData: result.inlineData } : {}),
    };
    return finish('done', sanitized);
  } catch (error) {
    const message = errorMessage(error);
    return finish('error', { output: { error: message }, summary: `Falhou: ${message}` });
  }
}
