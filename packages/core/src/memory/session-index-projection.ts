import { projectSessionReplay } from '../session-replay.js';
import type { CodingReplayStep, SessionReplayProjection } from '../session-replay-types.js';
import { JsonlSessionEventStoreError } from './jsonl-errors.js';
import { parseJsonlSessionLog } from './jsonl-session-records.js';
import type {
    SessionIndexDiagnostic,
    SessionIndexProviderFailureRecord,
    SessionIndexRecord,
    SessionIndexRunRecord,
} from './session-index-types.js';

export type SessionIndexProjection = {
    readonly records: readonly SessionIndexRecord[];
    readonly diagnostics: readonly SessionIndexDiagnostic[];
};

export function deriveSessionIndexRecords(input: {
    readonly sessionId: string;
    readonly filePath: string;
    readonly contents: string;
}): SessionIndexProjection {
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

class SessionIndexProjectionError extends Error {
    readonly name = 'SessionIndexProjectionError';

    constructor(readonly eventId: string) {
        super(`session index projection lost event sequence for ${eventId}`);
    }
}

function recordsForProjection(projection: SessionReplayProjection, filePath: string): readonly SessionIndexRecord[] {
    const sequenceByEventId = new Map(projection.envelopes.map((envelope) => [envelope.eventId, envelope.sequence]));
    return [
        sessionRecord(projection, filePath),
        ...projection.codingSteps.flatMap((step) => recordsForStep(projection.sessionId, step, sequenceByEventId)),
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
        throw new SessionIndexProjectionError(eventId);
    }
    return sequence;
}

function sessionRecord(projection: SessionReplayProjection, filePath: string): SessionIndexRecord {
    const lastEnvelope = projection.envelopes.at(-1);
    return {
        kind: 'session',
        sessionId: projection.sessionId,
        status: projection.snapshot.status,
        startedAt: projection.snapshot.startedAt,
        ...(projection.snapshot.stoppedAt !== undefined ? { stoppedAt: projection.snapshot.stoppedAt } : {}),
        eventCount: projection.envelopes.length,
        ...(lastEnvelope !== undefined ? { lastSequence: lastEnvelope.sequence } : {}),
        ...(lastEnvelope !== undefined ? { lastEventId: lastEnvelope.eventId } : {}),
        ...(lastEnvelope !== undefined ? { lastEventType: lastEnvelope.event.type } : {}),
        updatedAt: lastEnvelope?.createdAt ?? projection.snapshot.startedAt,
        sourceFilePath: filePath,
    };
}

function recordsForStep(
    sessionId: string,
    step: CodingReplayStep,
    sequenceByEventId: ReadonlyMap<string, number>,
): readonly (SessionIndexRunRecord | SessionIndexProviderFailureRecord)[] {
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
): SessionIndexDiagnostic {
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

function jsonlErrorCode(error: unknown): SessionIndexDiagnostic['code'] {
    if (error instanceof JsonlSessionEventStoreError) {
        return error.code;
    }
    return 'unknown';
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return 'unknown JSONL index projection error';
}

function assertNever(value: never): never {
    throw new Error(`Unhandled session index projection variant: ${JSON.stringify(value)}`);
}
