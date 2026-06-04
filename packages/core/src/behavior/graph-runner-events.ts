import type {
    AbgNodeModelOptions,
    AbgNodeSpec,
    AbgPolicySpec,
    AgentEvent,
    PermissionDecision,
} from '@mission-control/protocol';
import type { AbgGraphRunnerInput } from './graph-runner.js';

export function graphEvent(
    type: 'graph.started' | 'graph.completed' | 'graph.failed',
    graphId: string,
    input: AbgGraphRunnerInput,
    message: string,
): AgentEvent {
    return {
        type,
        timestamp: input.now(),
        sessionId: input.sessionId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        abg: { graphId },
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
        status: 'deny',
        ...(policy.reason !== undefined ? { reason: policy.reason } : {}),
    };
}
