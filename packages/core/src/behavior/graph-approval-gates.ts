import {
    type AbgEmbeddedEvent,
    type AbgNodeSpec,
    type AbgPolicySpec,
    type AgentEvent,
    ApprovalLifecycleStateSchema,
    type ApprovalRecord,
} from '@mission-control/protocol';
import { z } from 'zod';
import type { AbgGraphRunnerInput } from './graph-runner.js';
import { approvalLifecycleEvent, graphEvent, permissionEvent, policyBlockedEvent } from './graph-runner-events.js';

const approvalReasonKey = 'reason';
const observedApprovalPayloadSchema = z
    .object({
        approvalId: z.string().min(1),
        state: ApprovalLifecycleStateSchema,
        reason: z.string().min(1).optional(),
    })
    .passthrough();

type ApprovalGateInput = {
    readonly graphId: string;
    readonly node: AbgNodeSpec;
    readonly policy?: AbgPolicySpec;
    readonly input: AbgGraphRunnerInput;
};

export type ApprovalGateResult =
    | {
          readonly kind: 'allowed';
          readonly events: readonly AgentEvent[];
          readonly approvedHumanApproval: boolean;
      }
    | {
          readonly kind: 'blocked';
          readonly events: readonly AgentEvent[];
      };

export function evaluateApprovalGate(gate: ApprovalGateInput): ApprovalGateResult {
    if (gate.policy?.decision === 'deny') {
        return blockedByPolicy(gate, 'policy_blocked', `ABG graph blocked: ${gate.node.id}`);
    }
    if (gate.policy?.decision === 'requires_approval') {
        return approvalDecision(gate, policyApprovalRecordInput(gate));
    }
    if (gate.node.kind === 'human-approval') {
        return approvalDecision(gate, humanApprovalRecordInput(gate));
    }
    return { kind: 'allowed', events: [], approvedHumanApproval: false };
}

function approvalDecision(gate: ApprovalGateInput, input: ApprovalRecordInput): ApprovalGateResult {
    const observed = observedApproval(gate.input.graphInput?.events ?? [], input.approvalId);
    if (observed?.state === 'approved') {
        const record = approvalRecord(input, 'approved', gate.input.now(), observed.reason);
        return {
            kind: 'allowed',
            events: [
                approvalLifecycleEvent(
                    'approval.resumed',
                    gate.graphId,
                    gate.node,
                    gate.input,
                    record,
                    'approval resumed',
                ),
            ],
            approvedHumanApproval: gate.node.kind === 'human-approval',
        };
    }
    if (observed !== undefined && observed.state !== 'pending') {
        const record = approvalRecord(input, observed.state, gate.input.now(), observed.reason);
        return blockedByApproval(gate, record, `approval blocked: ${observed.state}`, 'approval_blocked');
    }
    const record = approvalRecord(input, 'pending', gate.input.now());
    const pendingCode = gate.policy === undefined ? 'approval_required' : 'policy_blocked';
    return blockedByApproval(gate, record, `approval requested: ${input.action}`, pendingCode, 'approval.requested');
}

function blockedByPolicy(gate: ApprovalGateInput, code: string, message: string): ApprovalGateResult {
    if (gate.policy === undefined) {
        return {
            kind: 'blocked',
            events: [graphEvent('graph.failed', gate.graphId, gate.input, message, { error: { code, message } })],
        };
    }
    return {
        kind: 'blocked',
        events: [
            permissionEvent(gate.graphId, gate.node, gate.policy, gate.input),
            policyBlockedEvent(gate.graphId, gate.node, gate.policy, gate.input),
            graphEvent('graph.failed', gate.graphId, gate.input, message, { error: { code, message } }),
        ],
    };
}

function blockedByApproval(
    gate: ApprovalGateInput,
    record: ApprovalRecord,
    approvalMessage: string,
    code: string,
    eventType: 'approval.requested' | 'approval.blocked' = 'approval.blocked',
): ApprovalGateResult {
    const graphMessage = `ABG graph blocked: ${gate.node.id}`;
    return {
        kind: 'blocked',
        events: [
            ...(gate.policy !== undefined ? [permissionEvent(gate.graphId, gate.node, gate.policy, gate.input)] : []),
            approvalLifecycleEvent(eventType, gate.graphId, gate.node, gate.input, record, approvalMessage),
            policyBlockedEvent(gate.graphId, gate.node, gate.policy ?? fallbackPolicy(record), gate.input),
            graphEvent('graph.failed', gate.graphId, gate.input, graphMessage, {
                error: { code, message: graphMessage, retryable: false },
            }),
        ],
    };
}

type ApprovalRecordInput = {
    readonly approvalId: string;
    readonly requestId: string;
    readonly action: string;
    readonly subject: ApprovalRecord['subject'];
    readonly reason: string;
};

function policyApprovalRecordInput(gate: ApprovalGateInput): ApprovalRecordInput {
    const requestId = permissionRequestId(gate.graphId, gate.node.id);
    return {
        approvalId: approvalIdFor(requestId),
        requestId,
        action: gate.policy?.capability ?? gate.node.id,
        subject: { kind: 'node', id: gate.node.id },
        reason: gate.policy?.reason ?? `approval required: ${gate.node.id}`,
    };
}

function humanApprovalRecordInput(gate: ApprovalGateInput): ApprovalRecordInput {
    const requestId = permissionRequestId(gate.graphId, gate.node.id);
    return {
        approvalId: approvalIdFor(requestId),
        requestId,
        action: `human-approval:${gate.node.id}`,
        subject: { kind: 'node', id: gate.node.id },
        reason: readNodeReason(gate.node) ?? `human approval required: ${gate.node.id}`,
    };
}

function approvalRecord(
    input: ApprovalRecordInput,
    state: ApprovalRecord['state'],
    timestamp: string,
    reason = input.reason,
): ApprovalRecord {
    return {
        approvalId: input.approvalId,
        requestId: input.requestId,
        policyDecision: 'requires_approval',
        state,
        subject: input.subject,
        requestedAt: timestamp,
        ...(state !== 'pending' ? { decidedAt: timestamp } : {}),
        reason,
    };
}

function observedApproval(events: readonly AbgEmbeddedEvent[], approvalId: string) {
    for (const event of [...events].reverse()) {
        if (event.type !== 'approval.updated') {
            continue;
        }
        const parsed = observedApprovalPayloadSchema.safeParse(event.payload);
        if (parsed.success && parsed.data.approvalId === approvalId) {
            return parsed.data;
        }
    }
    return undefined;
}

function fallbackPolicy(record: ApprovalRecord): AbgPolicySpec {
    return {
        id: record.approvalId,
        capability: record.subject.id,
        decision: 'requires_approval',
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
    };
}

function permissionRequestId(graphId: string, nodeId: string): string {
    return `permission_${graphId}_${nodeId}`;
}

function approvalIdFor(requestId: string): string {
    return `approval_${requestId}`;
}

function readNodeReason(node: AbgNodeSpec): string | undefined {
    const value = node.config?.[approvalReasonKey];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
