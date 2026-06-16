import type { AbgNodeKind, AbgNodeModelOptions, AbgSignal, AgentEvent } from '@mission-control/protocol';

export type AbgSignalProjectionInput = {
    readonly graphId: string;
    readonly sessionId: string;
    readonly timestamp: string;
    readonly signal: AbgSignal;
    readonly causationId?: string;
    readonly correlationId?: string;
    readonly nodeKind?: AbgNodeKind;
    readonly model?: AbgNodeModelOptions;
    readonly attempt?: number;
    readonly maxAttempts?: number;
};

export function projectAbgSignalToEvent(input: AbgSignalProjectionInput): AgentEvent {
    return {
        type: eventTypeForSignal(input.signal),
        timestamp: input.timestamp,
        durability: 'durable',
        sessionId: input.sessionId,
        message: messageForSignal(input.signal),
        abg: {
            graphId: input.graphId,
            nodeId: input.signal.nodeId,
            ...(input.nodeKind !== undefined ? { nodeKind: input.nodeKind } : {}),
            signalType: input.signal.type,
            ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
            ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
            ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        },
        ...(modelProviderSelection(input.model) ?? {}),
    };
}

function eventTypeForSignal(signal: AbgSignal): AgentEvent['type'] {
    switch (signal.type) {
        case 'started':
            return 'node.started';
        case 'progress':
        case 'spawn':
        case 'fallback':
            return 'node.progress';
        case 'emit':
            return 'log';
        case 'select':
            return 'decision.selected';
        case 'transition':
            return 'workflow.transitioned';
        case 'cancel':
        case 'cancelled':
            return 'node.cancelled';
        case 'success':
            return 'node.completed';
        case 'failure':
        case 'escalate':
            return 'node.failed';
        default:
            return assertNever(signal);
    }
}

function messageForSignal(signal: AbgSignal): string {
    switch (signal.type) {
        case 'started':
            return `node started: ${signal.nodeId}`;
        case 'progress':
            return signal.message ?? `node progress: ${signal.nodeId}`;
        case 'emit':
            return `node emitted event: ${signal.event.type}`;
        case 'select':
            return signal.reason ?? `node selected: ${signal.target}`;
        case 'transition':
            return `workflow transitioned: ${signal.from} -> ${signal.to}`;
        case 'spawn':
            return `actor spawned: ${signal.actor}`;
        case 'cancel':
            return signal.reason ?? `node cancel requested: ${signal.target}`;
        case 'success':
            return `node completed: ${signal.nodeId}`;
        case 'failure':
            return `node failed: ${signal.nodeId}`;
        case 'cancelled':
            return signal.reason ?? `node cancelled: ${signal.nodeId}`;
        case 'escalate':
            return signal.reason ?? `node escalated: ${signal.nodeId}`;
        case 'fallback':
            return signal.reason ?? `node requested fallback: ${signal.nodeId}`;
        default:
            return assertNever(signal);
    }
}

function modelProviderSelection(
    model: AbgNodeModelOptions | undefined,
): Pick<AgentEvent, 'modelProviderSelection'> | undefined {
    if (model === undefined) {
        return undefined;
    }
    return {
        modelProviderSelection: {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(model.variantID !== undefined ? { variantID: model.variantID } : {}),
        },
    };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled ABG signal: ${String(value)}`);
}
