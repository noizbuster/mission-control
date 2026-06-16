/**
 * ABG Policy Gate Node
 *
 * Per-action dynamic policy gate that evaluates a 3-state decision (allow/deny/requires_approval)
 * for a given capability. This is complementary to the coordinator-level graph.policies gate,
 * which acts on node.capabilities before the node runs.
 *
 * This node's job is to EVALUATE and ROUTE — it always succeeds (yields success) because
 * the actual policy enforcement happens via rule-gated edges that observe the emitted
 * 'policy.evaluated' event and route based on `policy.decision.equals` predicates.
 *
 * When a node emits a 'policy.evaluated' event whose payload contains { decision, capability, reason? },
 * the coordinator extracts that decision into the rule-evaluation input, enabling downstream
 * edges to match `policy.decision.equals <value>` and route to the appropriate node:
 * - deny → block node
 * - requires_approval → human-approval node
 * - allow → tool-actor (or other downstream node)
 *
 * This resolves the issue from review #10 where policy decisions were previously buried
 * inside SDK tool-execute callbacks and not observable at the graph level.
 */

import type { AbgNodeSpec, AbgPolicyDecision, AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunContext } from '../node-registry.js';

export async function* runPolicyGateNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield {
        type: 'started',
        graphId: context.graphId,
        nodeId: node.id,
    };

    const capability = node.config?.['capability'];
    const capabilityString =
        typeof capability === 'string' && capability.length > 0 ? capability : node.capabilities?.[0];

    if (typeof capabilityString !== 'string' || capabilityString.length === 0) {
        yield {
            type: 'failure',
            graphId: context.graphId,
            nodeId: node.id,
            error: { code: 'policy_capability_required' },
        };
        return;
    }

    const policies = context.policies ?? [];
    let decision: AbgPolicyDecision = 'allow';
    let reason: string | undefined;

    for (const policy of policies) {
        if (policy.capability === capabilityString) {
            if (policy.decision === 'deny') {
                decision = 'deny';
                reason = policy.reason;
                break;
            }
            if (policy.decision === 'requires_approval' && decision === 'allow') {
                decision = 'requires_approval';
                reason = policy.reason;
            }
        }
    }

    const payload: { decision: AbgPolicyDecision; capability: string; reason?: string } = {
        decision,
        capability: capabilityString,
    };
    if (reason !== undefined) {
        payload.reason = reason;
    }

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId: node.id,
        eventType: 'policy.evaluated',
        source: 'policy-gate',
        timestamp: context.now(),
        payload,
    });

    const result: { decision: AbgPolicyDecision; capability: string; reason?: string } = {
        decision,
        capability: capabilityString,
    };
    if (reason !== undefined) {
        result.reason = reason;
    }

    yield {
        type: 'success',
        graphId: context.graphId,
        nodeId: node.id,
        result,
    };
}
