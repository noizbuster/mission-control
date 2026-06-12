import {
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventEnvelopeSchema,
    AgentEventLogSchema,
    type AgentSession,
} from '@mission-control/protocol';
import { deriveAbgGraphSnapshot } from './behavior/graph-state.js';
import { projectAbgTimeline } from './behavior/timeline.js';
import {
    JSONL_SESSION_EVENT_RECORD_KIND,
    JSONL_SESSION_LOG_HEADER_KIND,
    JSONL_SESSION_LOG_RECORD_VERSION,
} from './memory/jsonl-session-records.js';
import { projectBranchSummaries, projectSessionBranchTree } from './session-branch-projection.js';
import { SessionEventLog } from './session-log.js';
import { projectCodingSteps, projectReplayDiagnostics } from './session-replay-coding.js';
import { projectApprovals, projectToolOutcomes } from './session-replay-event-projections.js';
import type {
    JsonlSessionReplayPrefixProjection,
    ReplayDiagnostic,
    SessionReplayProjection,
} from './session-replay-types.js';

export type {
    ApprovalProjection,
    CodingReplayStep,
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
        codingSteps: projectCodingSteps(envelopes),
        diagnostics: projectReplayDiagnostics(envelopes),
    };
}

export function projectJsonlSessionReplayPrefix(input: {
    readonly sessionId: string;
    readonly contents: string;
}): JsonlSessionReplayPrefixProjection {
    const lines = nonEmptyLines(input.contents);
    const headerLine = lines.at(0);
    if (headerLine === undefined) {
        return {
            projection: projectSessionReplay({ sessionId: input.sessionId, envelopes: [] }),
            diagnostics: [],
        };
    }
    if (!isValidHeaderLine(headerLine.text, input.sessionId)) {
        return emptyProjectionWithDiagnostic(input.sessionId, headerLine.lineNumber);
    }
    const envelopes: AgentEventEnvelope[] = [];
    let previousSequence = -1;
    const seenEventIds = new Set<string>();
    for (const line of lines.slice(1)) {
        const parsed = parseReplayEnvelopeLine(line.text, input.sessionId);
        if (parsed === undefined || parsed.sequence <= previousSequence || seenEventIds.has(parsed.eventId)) {
            return prefixProjection(input.sessionId, envelopes, line.lineNumber);
        }
        previousSequence = parsed.sequence;
        seenEventIds.add(parsed.eventId);
        envelopes.push(parsed);
    }
    const projection = projectSessionReplay({ sessionId: input.sessionId, envelopes });
    return { projection, diagnostics: projection.diagnostics };
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

function isValidHeaderLine(line: string, sessionId: string): boolean {
    const value = parseJsonLine(line);
    return (
        isRecord(value) &&
        value.kind === JSONL_SESSION_LOG_HEADER_KIND &&
        value.version === JSONL_SESSION_LOG_RECORD_VERSION &&
        value.sessionId === sessionId &&
        typeof value.createdAt === 'string' &&
        value.createdAt.length > 0
    );
}

function parseReplayEnvelopeLine(line: string, sessionId: string): AgentEventEnvelope | undefined {
    const value = parseJsonLine(line);
    if (
        !isRecord(value) ||
        value.kind !== JSONL_SESSION_EVENT_RECORD_KIND ||
        value.version !== JSONL_SESSION_LOG_RECORD_VERSION
    ) {
        return undefined;
    }
    const parsedEnvelope = AgentEventEnvelopeSchema.safeParse(value.event);
    if (!parsedEnvelope.success) {
        return undefined;
    }
    const envelope = parsedEnvelope.data;
    if (envelope.sessionId !== sessionId || envelope.event.sessionId !== sessionId) {
        return undefined;
    }
    return envelope.durability === 'durable' ? envelope : undefined;
}

function parseJsonLine(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

function prefixProjection(
    sessionId: string,
    envelopes: readonly AgentEventEnvelope[],
    lineNumber: number,
): JsonlSessionReplayPrefixProjection {
    const projection = projectSessionReplay({ sessionId, envelopes });
    return {
        projection,
        diagnostics: [...projection.diagnostics, corruptTrailingRecord(sessionId, lineNumber)],
    };
}

function emptyProjectionWithDiagnostic(sessionId: string, lineNumber: number): JsonlSessionReplayPrefixProjection {
    return {
        projection: projectSessionReplay({ sessionId, envelopes: [] }),
        diagnostics: [corruptTrailingRecord(sessionId, lineNumber)],
    };
}

function isRecord(value: unknown): value is {
    readonly kind?: unknown;
    readonly version?: unknown;
    readonly sessionId?: unknown;
    readonly createdAt?: unknown;
    readonly event?: unknown;
} {
    return typeof value === 'object' && value !== null;
}

function corruptTrailingRecord(sessionId: string, lineNumber: number): ReplayDiagnostic {
    return {
        code: 'corrupt_trailing_record',
        lineNumber,
        sessionId,
    };
}
