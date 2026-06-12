import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import type { ApprovalProjection, ToolOutcomeProjection, ToolOutcomeStatus } from './session-replay-types.js';

export function projectApprovals(envelopes: readonly AgentEventEnvelope[]): readonly ApprovalProjection[] {
    const approvals = new Map<string, ApprovalProjection>();
    for (const envelope of envelopes) {
        const record = envelope.event.approvalRecord;
        if (record === undefined) {
            continue;
        }
        approvals.set(record.approvalId, {
            ...record,
            eventId: envelope.eventId,
            updatedAt: envelope.event.timestamp,
        });
    }
    return [...approvals.values()];
}

export function projectToolOutcomes(events: readonly AgentEvent[]): readonly ToolOutcomeProjection[] {
    const outcomes = new Map<string, ToolOutcomeProjection>();
    for (const event of events) {
        const toolId = event.toolResult?.toolCallId ?? event.taskId ?? event.abg?.nodeId;
        if (toolId === undefined) {
            continue;
        }
        const withDiff = nextDiffOutcome(outcomes.get(toolId), toolId, event);
        const toolStatus = toolStatusForEvent(event.type);
        if (toolStatus === undefined) {
            if (withDiff !== undefined) {
                outcomes.set(toolId, withDiff);
            }
            continue;
        }
        outcomes.set(toolId, nextToolOutcome(withDiff, toolId, toolStatus, event));
    }
    return [...outcomes.values()];
}

function nextToolOutcome(
    current: ToolOutcomeProjection | undefined,
    toolId: string,
    status: ToolOutcomeStatus,
    event: AgentEvent,
): ToolOutcomeProjection {
    return {
        toolId,
        status,
        ...(current?.startedAt !== undefined ? { startedAt: current.startedAt } : {}),
        ...(status === 'started' ? { startedAt: event.timestamp } : {}),
        ...(current?.completedAt !== undefined ? { completedAt: current.completedAt } : {}),
        ...(status === 'completed' ? { completedAt: event.timestamp } : {}),
        ...(current?.failedAt !== undefined ? { failedAt: current.failedAt } : {}),
        ...(status === 'failed' ? { failedAt: event.timestamp } : {}),
        ...(event.message !== undefined
            ? { lastMessage: event.message }
            : current?.lastMessage !== undefined
              ? { lastMessage: current.lastMessage }
              : {}),
        ...(current?.result !== undefined ? { result: current.result } : {}),
        ...(event.toolResult !== undefined ? { result: event.toolResult } : {}),
        ...(current?.appliedFiles !== undefined ? { appliedFiles: current.appliedFiles } : {}),
    };
}

function nextDiffOutcome(
    current: ToolOutcomeProjection | undefined,
    toolId: string,
    event: AgentEvent,
): ToolOutcomeProjection | undefined {
    if (event.type !== 'file.diff.applied' || event.diffFiles === undefined) {
        return current;
    }
    const appliedFiles = uniqueStrings([
        ...(current?.appliedFiles ?? []),
        ...event.diffFiles.map((diffFile) => diffFile.filePath),
    ]);
    return {
        toolId,
        status: current?.status ?? 'started',
        ...(current?.startedAt !== undefined ? { startedAt: current.startedAt } : {}),
        ...(current?.completedAt !== undefined ? { completedAt: current.completedAt } : {}),
        ...(current?.failedAt !== undefined ? { failedAt: current.failedAt } : {}),
        ...(current?.lastMessage !== undefined ? { lastMessage: current.lastMessage } : {}),
        ...(current?.result !== undefined ? { result: current.result } : {}),
        appliedFiles,
    };
}

function toolStatusForEvent(eventType: AgentEvent['type']): ToolOutcomeStatus | undefined {
    switch (eventType) {
        case 'tool.started':
            return 'started';
        case 'tool.completed':
            return 'completed';
        case 'tool.failed':
            return 'failed';
        default:
            return undefined;
    }
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}
