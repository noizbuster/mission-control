import {
    type LocalSessionEventStore,
    type ObservabilityRedactor,
    redactAgentEventForObservability,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';

type OwnerPromptEventTarget = {
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly emitEvent: (event: AgentEvent) => void;
};

export async function nextOwnerPromptTaskId(store: LocalSessionEventStore, sessionId: string): Promise<string> {
    const events = await store.getEvents(sessionId);
    let maxIndex = 0;
    for (const event of events) {
        if (event.sessionId !== sessionId) {
            continue;
        }
        maxIndex = Math.max(maxIndex, maxNumericSuffix(ownerPromptIdsFromEvent(event)));
    }
    return `task_prompt_${maxIndex + 1}`;
}

export function emitOwnerPromptTaskEvent(
    target: OwnerPromptEventTarget,
    taskId: string,
    type: 'task.started' | 'task.completed' | 'task.failed',
    message: string,
    observabilityRedactor: ObservabilityRedactor,
): void {
    target.emitEvent(
        redactAgentEventForObservability(
            {
                type,
                timestamp: new Date().toISOString(),
                sessionId: target.sessionId,
                taskId,
                message,
                nativeSidecarStatus: 'mock',
                modelProviderSelection: target.modelProviderSelection,
            },
            observabilityRedactor,
        ),
    );
}

function ownerPromptIdsFromEvent(event: AgentEvent): readonly (string | undefined)[] {
    return [
        event.taskId,
        event.run?.runId,
        event.run?.inputId,
        event.run?.messageId,
        event.run?.providerTurnId,
        event.run?.toolCallId,
        event.run?.graphId,
        event.run?.nodeId,
        event.transcript?.inputId,
        event.transcript?.messageId,
        event.transcript?.providerTurnId,
        event.transcript?.toolCallId,
        event.transcript?.graphId,
        event.transcript?.nodeId,
        event.providerStreamChunk?.requestId,
    ];
}

function maxNumericSuffix(ids: readonly (string | undefined)[]): number {
    let maxIndex = 0;
    for (const id of ids) {
        const index = numericSuffix(id);
        if (index !== undefined) {
            maxIndex = Math.max(maxIndex, index);
        }
    }
    return maxIndex;
}

function numericSuffix(id: string | undefined): number | undefined {
    const match = id?.match(/_(\d+)$/u);
    if (match?.[1] === undefined) {
        return undefined;
    }
    return Number.parseInt(match[1], 10);
}
