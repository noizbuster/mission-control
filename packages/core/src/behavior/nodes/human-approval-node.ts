/**
 * ABG Human Approval Node
 *
 * This leaf node makes an approval request observable in the node's own signal stream.
 * It is reached for explicit human-approval nodes and after a policy-gate routes
 * `requires_approval` here.
 *
 * The coordinator's approval gate (packages/core/src/behavior/graph-approval-gates.ts,
 * evaluateApprovalGate, run in runQueuedNode) is the AUTHORITY that blocks the graph
 * and resumes on an observed `approval.updated` event (state approved/denied). This
 * node serves to emit the approval request event so the graph can respond appropriately.
 *
 * This node always yields a failure with code 'human_approval_required' because the
 * actual approval handling happens at the coordinator level via the approval gate mechanism.
 */

import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunContext } from '../node-registry.js';

export async function* runHumanApprovalNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield {
        type: 'started',
        graphId: context.graphId,
        nodeId: node.id,
    };

    const approvalId = `approval_${context.graphId}_${node.id}`;
    const actionConfig = node.config?.['action'];
    const action =
        typeof actionConfig === 'string' && actionConfig.length > 0 ? actionConfig : `human-approval:${node.id}`;
    const reasonConfig = node.config?.['reason'];
    const reason = typeof reasonConfig === 'string' && reasonConfig.length > 0 ? reasonConfig : undefined;

    const payload: { approvalId: string; action: string; reason?: string } = {
        approvalId,
        action,
    };
    if (reason !== undefined) {
        payload.reason = reason;
    }

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId: node.id,
        eventType: 'approval.requested',
        source: node.id,
        timestamp: context.now(),
        payload,
    });

    const error: { code: string; approvalId: string; action: string } = {
        code: 'human_approval_required',
        approvalId,
        action,
    };

    yield {
        type: 'failure',
        graphId: context.graphId,
        nodeId: node.id,
        error,
    };
}
