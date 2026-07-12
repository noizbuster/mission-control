import type { AgentEvent, ToolCall } from '@mission-control/protocol';

export type BlockedToolAuthority = {
    readonly runId: string;
    readonly toolCall: ToolCall;
    readonly toolCallEventIndex: number;
    readonly blockedEventIndex: number;
};

export function currentBlockedToolAuthority(events: readonly AgentEvent[]): BlockedToolAuthority | undefined {
    const blockedEventIndex = lastIndexWhere(events, (event) => isRunStateEvent(event.type));
    const blockedEvent = events[blockedEventIndex];
    if (blockedEvent?.type !== 'run.blocked' || blockedEvent.run?.state !== 'blocked_on_approval') {
        return undefined;
    }

    const runId = blockedEvent.run.runId;
    const blockedToolCallId = blockedEvent.run.toolCallId;
    if (runId === undefined || blockedToolCallId === undefined) return undefined;
    const runStartIndex = lastIndexWhere(
        events.slice(0, blockedEventIndex),
        (event) => event.type === 'run.started' && event.run?.runId === runId,
    );
    if (
        events
            .slice(runStartIndex + 1, blockedEventIndex)
            .some((event) => event.run?.runId === runId && isTerminalRunEvent(event.type))
    ) {
        return undefined;
    }

    const proposed = findToolCallBefore(events, blockedEventIndex, blockedToolCallId);
    return proposed === undefined ? undefined : { runId, ...proposed, blockedEventIndex };
}

export function findToolCallBefore(
    events: readonly AgentEvent[],
    exclusiveEndIndex: number,
    toolCallId: string,
): { readonly toolCall: ToolCall; readonly toolCallEventIndex: number } | undefined {
    for (let index = exclusiveEndIndex - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined) continue;
        const toolCall = toolCallsFromEvent(event).find((candidate) => candidate.toolCallId === toolCallId);
        if (toolCall !== undefined) return { toolCall, toolCallEventIndex: index };
    }
    return undefined;
}

export function toolCallsFromEvents(events: readonly AgentEvent[]): readonly ToolCall[] {
    return events.flatMap(toolCallsFromEvent);
}

function toolCallsFromEvent(event: AgentEvent): readonly ToolCall[] {
    const chunk = event.providerStreamChunk;
    if (chunk?.kind === 'tool_call_completed') return [chunk.toolCall];

    const emit = event.abg?.emit;
    if (emit === undefined || emit.type !== 'llm.tool_call.proposed') return [];
    const payload = emit.payload;
    if (typeof payload !== 'object' || payload === null) return [];
    if (!('toolCallId' in payload) || typeof payload.toolCallId !== 'string') return [];
    if (!('toolName' in payload) || typeof payload.toolName !== 'string') return [];
    const input = 'input' in payload ? payload.input : undefined;
    return [{ toolCallId: payload.toolCallId, toolName: payload.toolName, argumentsJson: JSON.stringify(input ?? {}) }];
}

function lastIndexWhere<T>(values: readonly T[], predicate: (value: T) => boolean): number {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (value !== undefined && predicate(value)) return index;
    }
    return -1;
}

function isTerminalRunEvent(type: AgentEvent['type']): boolean {
    switch (type) {
        case 'run.completed':
        case 'run.failed':
        case 'run.interrupted':
            return true;
        default:
            return false;
    }
}

function isRunStateEvent(type: AgentEvent['type']): boolean {
    switch (type) {
        case 'run.started':
        case 'run.completed':
        case 'run.interrupted':
        case 'run.failed':
        case 'run.blocked':
        case 'run.idle':
            return true;
        default:
            return false;
    }
}
