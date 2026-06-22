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

import type {
    AbgNodeSpec,
    AbgPolicyDecision,
    AbgSignal,
    PolicyEffect,
    PolicyEffectRule,
    PolicyEffectRuleSet,
} from '@mission-control/protocol';
import { evaluateRules } from '../../permissions/rule-evaluator.js';
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

type ModePolicyEvaluatedPayload = {
    readonly decision: AbgPolicyDecision;
    readonly effect: PolicyEffect;
    readonly action: string;
    readonly resource: string;
    readonly reason?: string;
    readonly matchedRule?: PolicyEffectRule;
};

/**
 * Mode policy-gate node (Task 3.2) — enforces a workflow {@linkcode Mode}'s policies via the
 * Task 1.2 `evaluateRules` algebra (action/resource/effect, last-match-wins).
 *
 * Unlike {@linkcode runPolicyGateNode} (which consumes the graph-level `AbgPolicySpec`
 * capability/decision vocabulary), this node consumes the action/resource/effect
 * {@linkcode PolicyEffectRule} vocabulary carried by a workflow mode on `context.modePolicies`.
 * It evaluates a single attempted `(action, resource)` operation — e.g. an llm-actor's pending
 * write — and emits a `policy.evaluated` event carrying both the raw {@linkcode PolicyEffect}
 * (`effect`) and a routing-compatible {@linkcode AbgPolicyDecision} (`decision`).
 *
 * Outcomes: `deny` emits a reason and yields `failure` (`policy_blocked`) — the write is
 * BLOCKED; `allow` yields `success` — the llm-actor proceeds; `ask` yields `success` with
 * `decision: 'requires_approval'` so a `policy.decision.equals` edge can route to a
 * human-approval node.
 */
export async function* runModePolicyGateNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield {
        type: 'started',
        graphId: context.graphId,
        nodeId: node.id,
    };

    const action = readNonEmptyConfigString(node, 'action');
    const resource = readNonEmptyConfigString(node, 'resource');

    if (action === undefined || resource === undefined) {
        yield {
            type: 'failure',
            graphId: context.graphId,
            nodeId: node.id,
            error: { code: 'mode_policy_action_resource_required' },
        };
        return;
    }

    const ruleset: PolicyEffectRuleSet = { rules: [...(context.modePolicies ?? [])] };
    const { effect, matchedRule } = evaluateRules(action, resource, [ruleset]);
    const decision = modeEffectToDecision(effect);
    const reason = modePolicyReason(action, resource, effect, matchedRule);

    const payload: ModePolicyEvaluatedPayload = {
        decision,
        effect,
        action,
        resource,
        ...(reason !== undefined ? { reason } : {}),
        ...(matchedRule !== undefined ? { matchedRule } : {}),
    };

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId: node.id,
        eventType: 'policy.evaluated',
        source: 'mode-policy-gate',
        timestamp: context.now(),
        payload,
    });

    if (effect === 'deny') {
        yield {
            type: 'failure',
            graphId: context.graphId,
            nodeId: node.id,
            error: {
                code: 'policy_blocked',
                action,
                resource,
                effect,
                ...(reason !== undefined ? { reason } : {}),
            },
        };
        return;
    }

    yield {
        type: 'success',
        graphId: context.graphId,
        nodeId: node.id,
        result: { decision, effect, action, resource },
    };
}

function readNonEmptyConfigString(node: AbgNodeSpec, key: string): string | undefined {
    const value = node.config?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function modeEffectToDecision(effect: PolicyEffect): AbgPolicyDecision {
    switch (effect) {
        case 'allow':
            return 'allow';
        case 'deny':
            return 'deny';
        case 'ask':
            return 'requires_approval';
    }
}

function modePolicyReason(
    action: string,
    resource: string,
    effect: PolicyEffect,
    matchedRule: PolicyEffectRule | undefined,
): string | undefined {
    if (effect === 'allow') {
        return undefined;
    }
    const verdict = effect === 'deny' ? 'denied' : 'requires approval';
    if (matchedRule !== undefined) {
        return `${action} on '${resource}' ${verdict} by policy { action: '${matchedRule.action}', resource: '${matchedRule.resource}', effect: '${matchedRule.effect}' }`;
    }
    return `${action} on '${resource}' ${verdict}: no explicit allow rule matched`;
}
