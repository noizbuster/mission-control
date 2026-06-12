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
            const projection = projectSessionReplay({ sessionId: input.sessionId, envelopes: parsed.envelopes });
            const diagnostics =
                excludedLine === undefined
                    ? projection.diagnostics
                    : [...projection.diagnostics, corruptTrailingRecord(input.sessionId, excludedLine.lineNumber)];
            return { projection, diagnostics };
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
