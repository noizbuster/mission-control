import { projectSessionReplay } from '../session-replay';
import type { CodingReplayStep, SessionReplayProjection } from '../session-replay-types';
import { JsonlSessionEventStoreError } from './jsonl-errors';
import { parseJsonlSessionLog } from './jsonl-session-records';
import { isProviderAbortedFailure } from './session-projection-provider-failure';
import type {
    SessionProjectionDiagnostic,
    SessionProjectionProviderFailureRecord,
    SessionProjectionRecord,
    SessionProjectionRunRecord,
    SessionProjectionSessionRecord,
} from './session-projection-types';

export type SessionProjectionResult = {
    readonly records: readonly SessionProjectionRecord[];
    readonly diagnostics: readonly SessionProjectionDiagnostic[];
};

export function deriveSessionProjectionRecords(input: {
    readonly sessionId: string;
    readonly filePath: string;
    readonly contents: string;
}): SessionProjectionResult {
    const parsed = (() => {
        try {
            return parseJsonlSessionLog(input);
        } catch (error: unknown) {
            if (error instanceof JsonlSessionEventStoreError) {
                return diagnosticForError(input, error);
            }
            if (error instanceof Error) {
                return diagnosticForError(input, error);
            }
            return diagnosticForError(input, error);
        }
    })();
    if ('kind' in parsed) {
        return {
            records: [],
            diagnostics: [parsed],
        };
    }
    const projection = projectSessionReplay({ sessionId: input.sessionId, envelopes: parsed.envelopes });
    return {
        records: recordsForProjection(projection, input.filePath),
        diagnostics: [],
    };
}

export function deriveSessionProjectionRecordsFromEnvelopes(input: {
    readonly sessionId: string;
    readonly filePath: string;
    readonly envelopes: readonly Parameters<typeof projectSessionReplay>[0]['envelopes'][number][];
}): SessionProjectionResult {
    const projection = projectSessionReplay({ sessionId: input.sessionId, envelopes: input.envelopes });
    return {
        records: recordsForProjection(projection, input.filePath),
        diagnostics: [],
    };
}

class SessionProjectionError extends Error {
    readonly name = 'SessionProjectionError';

    constructor(readonly eventId: string) {
        super(`session projection lost event sequence for ${eventId}`);
    }
}

function recordsForProjection(
    projection: SessionReplayProjection,
    filePath: string,
): readonly SessionProjectionRecord[] {
    const sequenceByEventId = new Map(projection.envelopes.map((envelope) => [envelope.eventId, envelope.sequence]));
    const eventByEventId = new Map(projection.envelopes.map((envelope) => [envelope.eventId, envelope.event]));
    return [
        sessionRecord(projection, filePath),
        ...projection.codingSteps.flatMap((step) =>
            recordsForStep(projection.sessionId, step, sequenceByEventId, eventByEventId),
        ),
        ...projection.approvals.map((approval) => ({
            kind: 'approval' as const,
            sessionId: projection.sessionId,
            approvalId: approval.approvalId,
            eventId: approval.eventId,
            state: approval.state,
            subject: approval.subject,
            requestedAt: approval.requestedAt,
            ...(approval.decidedAt !== undefined ? { decidedAt: approval.decidedAt } : {}),
            updatedAt: approval.updatedAt,
        })),
        ...projection.toolOutcomes.map((tool) => ({
            kind: 'tool' as const,
            sessionId: projection.sessionId,
            toolId: tool.toolId,
            status: tool.status,
            ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
            ...(tool.completedAt !== undefined ? { completedAt: tool.completedAt } : {}),
            ...(tool.failedAt !== undefined ? { failedAt: tool.failedAt } : {}),
            ...(tool.lastMessage !== undefined ? { lastMessage: tool.lastMessage } : {}),
            ...(tool.result !== undefined ? { result: tool.result } : {}),
            ...(tool.appliedFiles !== undefined ? { appliedFiles: tool.appliedFiles } : {}),
        })),
    ];
}

function eventSequence(eventId: string, sequenceByEventId: ReadonlyMap<string, number>): number {
    const sequence = sequenceByEventId.get(eventId);
    if (sequence === undefined) {
        throw new SessionProjectionError(eventId);
    }
    return sequence;
}

function sessionRecord(projection: SessionReplayProjection, filePath: string): SessionProjectionRecord {
    const lastEnvelope = projection.envelopes.at(-1);
    const abortMarker = activeAbortMarker(projection);
    const tree = projection.sessionTree;
    const messageCount = projection.events.filter((event) => event.message !== undefined).length;
    return {
        kind: 'session',
        sessionId: projection.sessionId,
        status: projection.snapshot.status,
        ...(projection.snapshot.awaiting !== undefined ? { awaiting: projection.snapshot.awaiting } : {}),
        startedAt: projection.snapshot.startedAt,
        ...(projection.snapshot.stoppedAt !== undefined ? { stoppedAt: projection.snapshot.stoppedAt } : {}),
        eventCount: projection.envelopes.length,
        ...(lastEnvelope !== undefined ? { lastSequence: lastEnvelope.sequence } : {}),
        ...(lastEnvelope !== undefined ? { lastEventId: lastEnvelope.eventId } : {}),
        ...(lastEnvelope !== undefined ? { lastEventType: lastEnvelope.event.type } : {}),
        updatedAt: lastEnvelope?.createdAt ?? projection.snapshot.startedAt,
        sourcePath: filePath,
        ...(tree.parentSessionId !== undefined ? { parentSessionId: tree.parentSessionId } : {}),
        ...(tree.cwd !== undefined ? { cwd: tree.cwd } : {}),
        ...(tree.trustedRoot !== undefined ? { trustedRoot: tree.trustedRoot } : {}),
        ...(tree.workspaceTrust !== undefined ? { workspaceTrust: tree.workspaceTrust } : {}),
        ...(tree.sessionName !== undefined ? { name: tree.sessionName } : {}),
        messageCount,
        ...(tree.activeLeafId !== undefined ? { activeLeafId: tree.activeLeafId } : {}),
        ...(abortMarker !== undefined ? { abortMarker } : {}),
    };
}

function activeAbortMarker(
    projection: SessionReplayProjection,
): SessionProjectionSessionRecord['abortMarker'] | undefined {
    let marker: SessionProjectionSessionRecord['abortMarker'] | undefined;
    for (const envelope of projection.envelopes) {
        if (envelope.event.type === 'run.started') {
            marker = undefined;
        }
        if (envelope.event.type === 'session.abort.completed' && envelope.event.sessionStop !== undefined) {
            marker = {
                completedAt: envelope.event.timestamp,
                operationId: envelope.event.sessionStop.operationId,
                requestId: envelope.event.sessionStop.requestId,
            };
        }
    }
    return marker;
}

function recordsForStep(
    sessionId: string,
    step: CodingReplayStep,
    sequenceByEventId: ReadonlyMap<string, number>,
    eventByEventId: ReadonlyMap<string, Parameters<typeof projectSessionReplay>[0]['envelopes'][number]['event']>,
): readonly (SessionProjectionRunRecord | SessionProjectionProviderFailureRecord)[] {
    switch (step.kind) {
        case 'run.state':
            return [
                {
                    kind: 'run',
                    sessionId,
                    eventId: step.eventId,
                    sequence: eventSequence(step.eventId, sequenceByEventId),
                    timestamp: step.timestamp,
                    eventType: step.eventType,
                    ...(step.command !== undefined ? { command: step.command } : {}),
                    ...(step.state !== undefined ? { state: step.state } : {}),
                    ...(step.runId !== undefined ? { runId: step.runId } : {}),
                    ...(step.inputId !== undefined ? { inputId: step.inputId } : {}),
                    ...(step.providerTurnId !== undefined ? { providerTurnId: step.providerTurnId } : {}),
                    ...(step.reason !== undefined ? { reason: step.reason } : {}),
                    ...(step.errorCode !== undefined ? { errorCode: step.errorCode } : {}),
                },
            ];
        case 'provider.failure':
            if (isProviderAbortedFailure(step, eventByEventId.get(step.eventId))) {
                return [];
            }
            return [
                {
                    kind: 'provider_failure',
                    sessionId,
                    eventId: step.eventId,
                    timestamp: step.timestamp,
                    requestId: step.requestId,
                    ...(step.providerTurnId !== undefined ? { providerTurnId: step.providerTurnId } : {}),
                    error: step.error,
                },
            ];
        case 'approval':
        case 'provider.message':
        case 'provider.tool_call':
        case 'tool.result':
            return [];
        default:
            return assertNever(step);
    }
}

function diagnosticForError(
    input: { readonly sessionId: string; readonly filePath: string },
    error: unknown,
): SessionProjectionDiagnostic {
    return {
        kind: 'corrupt_jsonl',
        sessionId: input.sessionId,
        filePath: input.filePath,
        code: jsonlErrorCode(error),
        message: errorMessage(error),
        ...(error instanceof JsonlSessionEventStoreError && error.lineNumber !== undefined
            ? { lineNumber: error.lineNumber }
            : {}),
    };
}

function jsonlErrorCode(error: unknown): SessionProjectionDiagnostic['code'] {
    if (error instanceof JsonlSessionEventStoreError) {
        return error.code;
    }
    return 'unknown';
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return 'unknown JSONL session projection error';
}

function assertNever(value: never): never {
    throw new Error(`Unhandled session projection variant: ${JSON.stringify(value)}`);
}
