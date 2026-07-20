import {
    type AgentEvent,
    type GraphCheckpoint,
    GraphCheckpointSchema,
    type ProtocolErrorCode,
} from '@mission-control/protocol';

type GraphResumeRunMetadata = NonNullable<AgentEvent['run']>;

type GraphResumeAbgMetadata = {
    readonly graphId?: string | undefined;
    readonly checkpoint?: unknown;
};

export type GraphResumeEvent = {
    readonly type: AgentEvent['type'] | string;
    readonly timestamp?: string | undefined;
    readonly run?: GraphResumeRunMetadata | undefined;
    readonly abg?: GraphResumeAbgMetadata | undefined;
};

export type GraphCheckpointSearchOptions = {
    readonly runId?: string;
    readonly graphId?: string;
};

export type ResumableRunSnapshot =
    | {
          readonly kind: 'approval';
          readonly runId: string;
          readonly checkpoint?: GraphCheckpoint;
          readonly toolCallId?: string;
          readonly reason?: string;
          readonly errorCode?: ProtocolErrorCode;
      }
    | {
          readonly kind: 'interrupted';
          readonly runId: string;
          readonly checkpoint: GraphCheckpoint;
          readonly toolCallId?: string;
          readonly reason?: string;
          readonly errorCode?: ProtocolErrorCode;
      };

export function findLatestGraphCheckpoint(
    events: readonly GraphResumeEvent[],
    options: GraphCheckpointSearchOptions = {},
): GraphCheckpoint | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined || event.type !== 'graph.checkpoint') continue;
        const checkpoint = parseCheckpoint(event);
        if (checkpoint === undefined) continue;
        if (options.graphId !== undefined && checkpoint.graphId !== options.graphId) continue;
        if (options.runId !== undefined && !checkpointMatchesRun(checkpoint, event, options.runId)) continue;
        return checkpoint;
    }
    return undefined;
}

export function findResumableRun(events: readonly GraphResumeEvent[]): ResumableRunSnapshot | undefined {
    const interruptedRunIds = new Set<string>();

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const runId = event?.run?.runId;
        if (event === undefined || runId === undefined) continue;
        if (isFullTerminalRunEvent(event)) return undefined;

        if (event.type === 'run.interrupted') {
            const checkpoint = findLatestCheckpointInRunWindow(events, index, runId);
            if (checkpoint !== undefined && checkpoint.queuedNodeIds.length > 0) {
                return interruptedSnapshot(event, runId, checkpoint);
            }
            interruptedRunIds.add(runId);
            continue;
        }

        if (
            event.type === 'run.blocked' &&
            event.run?.state === 'blocked_on_approval' &&
            !interruptedRunIds.has(runId)
        ) {
            return approvalSnapshot(event, runId, findLatestCheckpointInRunWindow(events, index, runId));
        }
    }

    return undefined;
}

function parseCheckpoint(event: GraphResumeEvent): GraphCheckpoint | undefined {
    const payload = event.abg?.checkpoint;
    if (payload === undefined) return undefined;
    const parsed = GraphCheckpointSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
}

function checkpointMatchesRun(checkpoint: GraphCheckpoint, event: GraphResumeEvent, runId: string): boolean {
    return checkpoint.sessionRunId === runId || event.run?.runId === runId;
}

function checkpointBelongsToRunWindow(checkpoint: GraphCheckpoint, event: GraphResumeEvent, runId: string): boolean {
    if (checkpoint.sessionRunId !== undefined || event.run?.runId !== undefined) {
        return checkpointMatchesRun(checkpoint, event, runId);
    }
    return true;
}

function findLatestCheckpointInRunWindow(
    events: readonly GraphResumeEvent[],
    beforeIndex: number,
    runId: string,
): GraphCheckpoint | undefined {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined) continue;
        if (isFullTerminalRunEvent(event)) return undefined;
        if (event.type === 'run.started' && event.run?.runId === runId) return undefined;
        if (event.type !== 'graph.checkpoint') continue;
        const checkpoint = parseCheckpoint(event);
        if (checkpoint !== undefined && checkpointBelongsToRunWindow(checkpoint, event, runId)) return checkpoint;
    }
    return undefined;
}

function isFullTerminalRunEvent(event: GraphResumeEvent): boolean {
    return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.idle';
}

function approvalSnapshot(
    event: GraphResumeEvent,
    runId: string,
    checkpoint: GraphCheckpoint | undefined,
): ResumableRunSnapshot {
    return {
        kind: 'approval',
        runId,
        ...(checkpoint !== undefined ? { checkpoint } : {}),
        ...(event.run?.toolCallId !== undefined ? { toolCallId: event.run.toolCallId } : {}),
        ...(event.run?.reason !== undefined ? { reason: event.run.reason } : {}),
        ...(event.run?.errorCode !== undefined ? { errorCode: event.run.errorCode } : {}),
    };
}

function interruptedSnapshot(
    event: GraphResumeEvent,
    runId: string,
    checkpoint: GraphCheckpoint,
): ResumableRunSnapshot {
    return {
        kind: 'interrupted',
        runId,
        checkpoint,
        ...(event.run?.toolCallId !== undefined ? { toolCallId: event.run.toolCallId } : {}),
        ...(event.run?.reason !== undefined ? { reason: event.run.reason } : {}),
        ...(event.run?.errorCode !== undefined ? { errorCode: event.run.errorCode } : {}),
    };
}
