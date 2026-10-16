import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

import { bus } from '../lib/bus.js';
import type { ApprovalRequest, LarkEvent } from '../../shared/types.js';
import {
  cancelAllApprovals,
  listPendingApprovals,
  requestApproval,
  requestApprovalDetailed,
  resolveApproval,
} from './approvals.js';

const input = {
  toolName: 'delete_path',
  label: 'Enviando para a Lixeira',
  risk: 'dangerous' as const,
  description: 'Mover para a Lixeira: /tmp/x',
  args: { path: '/tmp/x' },
};

let events: LarkEvent[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  events = [];
  unsubscribe = bus.subscribe((e) => events.push(e));
});

afterEach(() => {
  unsubscribe();
  cancelAllApprovals();
  vi.useRealTimers();
});

function lastRequest(): ApprovalRequest {
  const e = [...events].reverse().find((ev) => ev.type === 'approval_request');
  if (!e || e.type !== 'approval_request') throw new Error('nenhum pedido publicado');
  return e.request;
}

describe('aprovações', () => {
  it('publica o pedido e resolve como aprovado', async () => {
    const pending = requestApproval(input);
    const req = lastRequest();
    expect(req.toolName).toBe('delete_path');
    expect(new Date(req.expiresAt).getTime() - new Date(req.createdAt).getTime()).toBe(120_000);
    expect(listPendingApprovals().map((r) => r.id)).toEqual([req.id]);

    expect(resolveApproval(req.id, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(events).toContainEqual({ type: 'approval_resolved', id: req.id, approved: true });
    expect(listPendingApprovals()).toHaveLength(0);
  });

  it('resolve como negado e ignora respostas repetidas', async () => {
    const pending = requestApproval(input);
    const req = lastRequest();
    expect(resolveApproval(req.id, false)).toBe(true);
    expect(resolveApproval(req.id, true)).toBe(false);
    await expect(pending).resolves.toBe(false);
    expect(events).toContainEqual({ type: 'approval_resolved', id: req.id, approved: false });
  });

  it('nega automaticamente quando o prazo acaba', async () => {
    vi.useFakeTimers();
    const pending = requestApprovalDetailed(input, 5_000);
    const req = lastRequest();
    vi.advanceTimersByTime(4_999);
    expect(listPendingApprovals()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual({ id: req.id, outcome: 'timeout' });
    expect(events).toContainEqual({ type: 'approval_resolved', id: req.id, approved: false });
    expect(resolveApproval(req.id, true)).toBe(false);
  });

  it('cancela quando o sinal é abortado', async () => {
    const controller = new AbortController();
    const pending = requestApprovalDetailed(input, 60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(listPendingApprovals()).toHaveLength(0);
  });

  it('não publica pedido com sinal já abortado', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(requestApproval(input, 60_000, controller.signal)).resolves.toBe(false);
    expect(events.filter((e) => e.type === 'approval_request')).toHaveLength(0);
  });

  it('cancelAllApprovals nega tudo que estava pendente', async () => {
    const a = requestApproval(input);
    const b = requestApproval({ ...input, toolName: 'run_command' });
    expect(listPendingApprovals()).toHaveLength(2);
    expect(cancelAllApprovals()).toBe(2);
    await expect(Promise.all([a, b])).resolves.toEqual([false, false]);
  });
});
