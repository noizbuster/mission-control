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
        const toolId =
            event.toolResult?.toolCallId ?? event.taskId ?? graphToolEventToolCallId(event) ?? event.abg?.nodeId;
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

/**
 * Recover the toolCallId a graph tool-lifecycle emit (tool.started/completed/failed from the
 * LLMActor adapter) carries in its `abg.emit.payload`, so graph tool outcomes key by tool call —
 * matching the flat path (where these events set `taskId`/`toolResult.toolCallId`). The graph's
 * adapter emits carry the toolCallId only in the persisted emit payload, not as a top-level field.
 */
function graphToolEventToolCallId(event: AgentEvent): string | undefined {
    const emit = event.abg?.emit;
    if (
        emit === undefined ||
        (emit.type !== 'tool.started' && emit.type !== 'tool.completed' && emit.type !== 'tool.failed')
    ) {
        return undefined;
    }
    const payload = emit.payload;
    if (typeof payload !== 'object' || payload === null || !('toolCallId' in payload)) {
        return undefined;
    }
    const value = payload.toolCallId;
    return typeof value === 'string' ? value : undefined;
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
