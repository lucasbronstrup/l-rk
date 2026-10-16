/**
 * Aprovações de ações no computador.
 *  GET /approvals → ApprovalRequest[] pendentes
 *  POST /approvals/:id {approved} → {ok} (404 se já expirou ou foi resolvida)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { listPendingApprovals, resolveApproval } from '../tools/approvals.js';
import { fail, parseBody } from './http.js';

const decisionSchema = z.object({
  approved: z.boolean({ error: 'Informe "approved": true para autorizar ou false para negar.' }),
});

export const approvalRoutes = new Hono();

approvalRoutes.get('/approvals', (c) => c.json(listPendingApprovals()));

approvalRoutes.post('/approvals/:id', async (c) => {
  const body = await parseBody(c, decisionSchema);
  if ('response' in body) return body.response;
  return resolveApproval(c.req.param('id'), body.data.approved)
    ? c.json({ ok: true })
    : fail(c, 404, 'Este pedido de autorização não existe mais (expirou ou já foi respondido).');
});
