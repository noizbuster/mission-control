import {
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventLogSchema,
    type AgentSession,
} from '@mission-control/protocol';
import { deriveAbgGraphSnapshot } from './behavior/graph-state.js';
import { projectAbgTimeline } from './behavior/timeline.js';
import { parseJsonlSessionLog } from './memory/jsonl-session-records.js';
import { projectBranchSummaries, projectSessionBranchTree } from './session-branch-projection.js';
import { SessionEventLog } from './session-log.js';
import type {
    ApprovalProjection,
    JsonlSessionReplayPrefixProjection,
    ReplayDiagnostic,
    SessionReplayProjection,
    ToolOutcomeProjection,
    ToolOutcomeStatus,
} from './session-replay-types.js';

export type {
    ApprovalProjection,
    JsonlSessionReplayPrefixProjection,
    ReplayDiagnostic,
    SessionBranchNode,
    SessionBranchSummary,
    SessionBranchTree,
    SessionReplayProjection,
    ToolOutcomeProjection,
    ToolOutcomeStatus,
} from './session-replay-types.js';

export function projectSessionReplay(input: {
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
}): SessionReplayProjection {
    const envelopes = AgentEventLogSchema.parse(input.envelopes).filter(
        (envelope) =>
            envelope.durability === 'durable' &&
            envelope.sessionId === input.sessionId &&
            envelope.event.sessionId === input.sessionId,
    );
    const events = envelopes.map((envelope) => envelope.event);
    const log = new SessionEventLog();
    for (const event of events) {
        log.append(event);
    }
    const branchTree = projectSessionBranchTree({ sessionId: input.sessionId, envelopes });

    return {
        sessionId: input.sessionId,
        envelopes,
        events,
        snapshot: log.getSnapshot(deriveSession(input.sessionId, events)),
        timeline: projectAbgTimeline(events),
        graphSnapshots: graphIdsFor(events).map((graphId) => deriveAbgGraphSnapshot(events, graphId)),
        branchTree,
        branchSummaries: projectBranchSummaries(branchTree),
        approvals: projectApprovals(envelopes),
        toolOutcomes: projectToolOutcomes(events),
    };
}

export function projectJsonlSessionReplayPrefix(input: {
    readonly sessionId: string;
    readonly contents: string;
}): JsonlSessionReplayPrefixProjection {
    const lines = nonEmptyLines(input.contents);
    for (let lineCount = lines.length; lineCount > 0; lineCount -= 1) {
        const candidate = `${lines
            .slice(0, lineCount)
            .map((line) => line.text)
            .join('\n')}\n`;
        try {
            const parsed = parseJsonlSessionLog({
                contents: candidate,
                filePath: `jsonl-prefix:${input.sessionId}`,
                sessionId: input.sessionId,
            });
            const excludedLine = lines.at(lineCount);
            return {
                projection: projectSessionReplay({ sessionId: input.sessionId, envelopes: parsed.envelopes }),
                diagnostics:
                    excludedLine === undefined ? [] : [corruptTrailingRecord(input.sessionId, excludedLine.lineNumber)],
            };
        } catch {
            if (lineCount === 1) {
                return {
                    projection: projectSessionReplay({ sessionId: input.sessionId, envelopes: [] }),
                    diagnostics: [corruptTrailingRecord(input.sessionId, lines.at(0)?.lineNumber ?? 1)],
                };
            }
        }
    }
    return {
        projection: projectSessionReplay({ sessionId: input.sessionId, envelopes: [] }),
        diagnostics: [],
    };
}

function graphIdsFor(events: readonly AgentEvent[]): readonly string[] {
    const graphIds = new Set<string>();
    for (const event of events) {
        if (event.abg?.graphId !== undefined) {
            graphIds.add(event.abg.graphId);
        }
    }
    return [...graphIds];
}

function projectApprovals(envelopes: readonly AgentEventEnvelope[]): readonly ApprovalProjection[] {
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

function projectToolOutcomes(events: readonly AgentEvent[]): readonly ToolOutcomeProjection[] {
    const outcomes = new Map<string, ToolOutcomeProjection>();
    for (const event of events) {
        const toolStatus = toolStatusForEvent(event.type);
        if (toolStatus === undefined) {
            continue;
        }
        const toolId = event.taskId ?? event.abg?.nodeId;
        if (toolId === undefined) {
            continue;
        }
        outcomes.set(toolId, nextToolOutcome(outcomes.get(toolId), toolId, toolStatus, event));
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

function deriveSession(sessionId: string, events: readonly AgentEvent[]): AgentSession {
    const sessionStarted = events.find((event) => event.type === 'session.started');
    let stoppedAt: string | undefined;
    for (const event of events) {
        if (event.type === 'session.stopped') {
            stoppedAt = event.timestamp;
        }
    }
    return {
        id: sessionId,
        status: stoppedAt === undefined ? 'running' : 'stopped',
        startedAt: sessionStarted?.timestamp ?? new Date(0).toISOString(),
        ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    };
}

function nonEmptyLines(contents: string): readonly { readonly text: string; readonly lineNumber: number }[] {
    return contents
        .split(/\r?\n/)
        .map((text, index) => ({ text, lineNumber: index + 1 }))
        .filter((line) => line.text.trim().length > 0);
}

function corruptTrailingRecord(sessionId: string, lineNumber: number): ReplayDiagnostic {
    return {
        code: 'corrupt_trailing_record',
        lineNumber,
        sessionId,
    };
}
