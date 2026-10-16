/**
 * Pedidos de aprovação para ações no computador.
 *
 * Quando uma ferramenta arriscada vai rodar, `runTool` chama `requestApproval`: o pedido é publicado
 * no bus (`approval_request`), a interface mostra o diálogo e responde por POST /api/approvals/:id,
 * que chama `resolveApproval`. Sem resposta dentro do prazo (padrão 120 s) a ação é negada.
 */
import { bus } from '../lib/bus.js';
import { newId } from '../lib/ids.js';
import type { ApprovalRequest } from '../../shared/types.js';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export type ApprovalOutcome = 'approved' | 'denied' | 'timeout' | 'cancelled';

interface PendingApproval {
  request: ApprovalRequest;
  settle: (outcome: ApprovalOutcome) => void;
}

const pending = new Map<string, PendingApproval>();

/**
 * Publica um pedido de aprovação e espera a decisão do usuário, informando também o motivo
 * (negado, prazo esgotado ou cancelado pelo `signal`).
 */
export function requestApprovalDetailed(
  input: Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ id: string; outcome: ApprovalOutcome }> {
  const id = newId();
  const created = Date.now();
  const ms = Math.max(1, Math.floor(timeoutMs));
  const request: ApprovalRequest = {
    ...input,
    id,
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + ms).toISOString(),
  };

  if (signal?.aborted) return Promise.resolve({ id, outcome: 'cancelled' });

  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => settle('timeout'), ms);
    timer.unref?.();
    const onAbort = () => settle('cancelled');

    function settle(outcome: ApprovalOutcome): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pending.delete(id);
      // Para prazos esgotados e cancelamentos a interface também precisa fechar o diálogo.
      bus.publish({ type: 'approval_resolved', id, approved: outcome === 'approved' });
      resolve({ id, outcome });
    }

    pending.set(id, { request, settle });
    signal?.addEventListener('abort', onAbort, { once: true });
    bus.publish({ type: 'approval_request', request });
  });
}

/** Contrato: resolve com a decisão do usuário (prazo esgotado ou cancelamento = negado). */
export async function requestApproval(
  input: Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  const { outcome } = await requestApprovalDetailed(input, timeoutMs, signal);
  return outcome === 'approved';
}

/** Registra a decisão do usuário. Retorna false se o pedido não existe mais (expirou ou já foi respondido). */
export function resolveApproval(id: string, approved: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.settle(approved ? 'approved' : 'denied');
  return true;
}

/** Pedidos aguardando resposta, do mais antigo para o mais novo. */
export function listPendingApprovals(): ApprovalRequest[] {
  return [...pending.values()]
    .map((p) => ({ ...p.request, args: { ...p.request.args } }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Nega todos os pedidos pendentes (ex.: ao encerrar o servidor). Retorna quantos foram cancelados. */
export function cancelAllApprovals(): number {
  const entries = [...pending.values()];
  for (const entry of entries) entry.settle('cancelled');
  return entries.length;
}
