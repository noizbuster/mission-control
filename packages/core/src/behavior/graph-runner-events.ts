import type {
    AbgEventMetadata,
    AbgNodeModelOptions,
    AbgNodeSpec,
    AbgPolicySpec,
    AbgRuntimeError,
    AgentEvent,
    ApprovalRecord,
    PermissionDecision,
} from '@mission-control/protocol';
import type { AbgGraphRunnerInput } from './graph-runner.js';

export function graphEvent(
    type: 'graph.started' | 'graph.completed' | 'graph.failed',
    graphId: string,
    input: AbgGraphRunnerInput,
    message: string,
    abg?: Omit<AbgEventMetadata, 'graphId'>,
): AgentEvent {
    return {
        type,
        timestamp: input.now(),
        sessionId: input.sessionId,
        message,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        abg: { graphId, ...abg },
    };
}

export function attemptEvent(
    type: 'attempt.started' | 'attempt.completed' | 'attempt.failed',
    graphId: string,
    node: AbgNodeSpec,
    input: AbgGraphRunnerInput,
    attempt: number,
    maxAttempts: number,
    error?: AbgRuntimeError,
): AgentEvent {
    return {
        type,
        timestamp: input.now(),
        sessionId: input.sessionId,
        message: `${type}: ${node.id}#${attempt}`,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        abg: {
            graphId,
            nodeId: node.id,
            attempt,
            maxAttempts,
            ...(error !== undefined ? { error } : {}),
        },
    };
}

export function nodeWaitingEvent(
    graphId: string,
    node: AbgNodeSpec,
    input: AbgGraphRunnerInput,
    reason: string,
): AgentEvent {
    return {
        type: 'node.waiting',
        timestamp: input.now(),
        sessionId: input.sessionId,
        message: `node waiting: ${node.id} (${reason})`,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        abg: {
            graphId,
            nodeId: node.id,
        },
    };
}

export function approvalLifecycleEvent(
    type: 'approval.requested' | 'approval.updated' | 'approval.blocked' | 'approval.resumed',
    graphId: string,
    node: AbgNodeSpec,
    input: AbgGraphRunnerInput,
    approvalRecord: ApprovalRecord,
    message: string,
): AgentEvent {
    return {
        type,
        timestamp: input.now(),
        sessionId: input.sessionId,
        message,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        approvalRecord,
        abg: {
            graphId,
            nodeId: node.id,
        },
    };
}

export function modelCallEvent(
    type: 'model.call.started' | 'model.call.completed',
    graphId: string,
    node: AbgNodeSpec,
    input: AbgGraphRunnerInput,
    model: AbgNodeModelOptions,
): AgentEvent {
    return {
        type,
        timestamp: input.now(),
        sessionId: input.sessionId,
        message: `${type}: ${node.id}`,
        durability: 'durable',
        modelProviderSelection: {
            providerID: model.providerID,
            modelID: model.modelID,
        },
        abg: {
            graphId,
            nodeId: node.id,
            model,
        },
    };
}

export function toolLifecycleEvent(
    type: 'tool.started' | 'tool.completed' | 'tool.failed',
    graphId: string,
    node: AbgNodeSpec,
    input: AbgGraphRunnerInput,
    message: string,
): AgentEvent {
    return {
        type,
        timestamp: input.now(),
        sessionId: input.sessionId,
        taskId: node.id,
        message,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        abg: {
            graphId,
            nodeId: node.id,
        },
    };
}

export function permissionEvent(
    graphId: string,
    node: AbgNodeSpec,
    policy: AbgPolicySpec,
    input: AbgGraphRunnerInput,
): AgentEvent {
    const requestId = `permission_${graphId}_${node.id}`;
    return {
        type: 'permission.requested',
        timestamp: input.now(),
        sessionId: input.sessionId,
        message: `permission requested: ${policy.capability}`,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        permissionRequest: {
            id: requestId,
            action: policy.capability,
            reason: policy.reason ?? `ABG policy ${policy.id}`,
        },
        permissionDecision: deniedDecision(requestId, policy),
        abg: {
            graphId,
            nodeId: node.id,
        },
    };
}

export function policyBlockedEvent(
    graphId: string,
    node: AbgNodeSpec,
    policy: AbgPolicySpec,
    input: AbgGraphRunnerInput,
): AgentEvent {
    return {
        type: 'policy.blocked',
        timestamp: input.now(),
        sessionId: input.sessionId,
        message: policy.reason ?? `ABG policy blocked capability: ${policy.capability}`,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        abg: {
            graphId,
            nodeId: node.id,
        },
    };
}

function deniedDecision(requestId: string, policy: AbgPolicySpec): PermissionDecision {
    return {
        requestId,
        status: policy.decision,
        ...(policy.reason !== undefined ? { reason: policy.reason } : {}),
    };
}
