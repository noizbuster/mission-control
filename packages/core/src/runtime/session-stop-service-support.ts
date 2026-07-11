import type { Client } from '@libsql/client';
import type {
    AgentEvent,
    SessionAbortAffectedCounts,
    SessionStopErrorCode,
    SessionStopOutcome,
} from '@mission-control/protocol';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db.js';
import type { SessionControlAttachedHandle } from './session-control-host.js';
import { SessionControlFencedError } from './session-control-host.js';
import { settleSessionControlOperationHandle } from './session-control-operation.js';
import { appendFencedSessionStopEvent } from './session-stop-event-writer.js';
import { refreshStoppedSession, type StopMutationResult } from './session-stop-mutation.js';
import type { ExactSessionStopInput, SessionStopReceipt } from './session-stop-service.js';

export const EMPTY_STOP_AFFECTED: SessionAbortAffectedCounts = {
    runs: 0,
    approvals: 0,
    sessionAwaits: 0,
    sessionInputs: 0,
    missionRuns: 0,
    asyncJobs: 0,
    toolCalls: 0,
};

export async function appendStopCancellationEvents(
    client: Client,
    input: ExactSessionStopInput,
    mutation: StopMutationResult,
    existingEvents: readonly AgentEvent[],
    timestamp: string,
): Promise<void> {
    for (const pending of mutation.inputs) {
        await appendFencedSessionStopEvent({
            client,
            sessionId: input.sessionId,
            event: {
                type: 'prompt.cancelled',
                timestamp,
                sessionId: input.sessionId,
                transcript: {
                    inputId: pending.inputId,
                    delivery: pending.delivery,
                    requestId: input.requestId,
                    reason: 'operator_aborted',
                },
            },
        });
    }
    for (const approvalId of mutation.approvalIds) {
        const record = latestApprovalRecord(existingEvents, approvalId);
        if (record === undefined) continue;
        await appendFencedSessionStopEvent({
            client,
            sessionId: input.sessionId,
            event: {
                type: 'approval.updated',
                timestamp,
                sessionId: input.sessionId,
                approvalRecord: { ...record, state: 'cancelled', decidedAt: timestamp, reason: 'operator_aborted' },
            },
        });
    }
}

export function abortCompletedEvent(
    input: ExactSessionStopInput,
    affected: SessionAbortAffectedCounts,
    timestamp: string,
): AgentEvent {
    return {
        type: 'session.abort.completed',
        timestamp,
        sessionId: input.sessionId,
        sessionStop: {
            operationId: input.operationId,
            requestId: input.requestId,
            reason: 'operator_aborted',
            affected,
        },
    };
}

export async function settleStopHandlesBeforeDeadline(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: Parameters<typeof settleSessionControlOperationHandle>[0]['lease'];
    readonly operationId: string;
    readonly sessionId: string;
    readonly requestId: string;
    readonly timestamp: string;
    readonly deadlineMonotonicMs: number;
    readonly monotonicNow: () => number;
    readonly handles: readonly SessionControlAttachedHandle[];
}): Promise<boolean> {
    const context = {
        kind: 'operator_stop',
        timestamp: input.timestamp,
        requestId: input.requestId,
        operationId: input.operationId,
    } as const;
    const settlement = Promise.all(
        input.handles.map(async (handle) => {
            await handle.abort(context);
            await handle.settled;
            const result = await settleSessionControlOperationHandle({
                runtime: input.runtime,
                lease: input.lease,
                operationId: input.operationId,
                handleKind: handle.kind,
                handleId: handle.handleId,
                attemptedEventType: `${handle.kind}.cancelled`,
                nowWallMs: Date.now(),
                metadata: { status: 'cancelled', errorCode: 'operator_aborted', signalAborted: true },
                write: async (client) => {
                    await handle.writeSettlement?.(client, context);
                    await refreshStoppedSession(client, input.sessionId, new Date().toISOString());
                },
            });
            if (!result.accepted) throw new SessionControlFencedError();
        }),
    ).then(() => true);
    const remaining = Math.max(0, input.deadlineMonotonicMs - input.monotonicNow());
    return Promise.race([settlement, delay(remaining).then(() => false)]);
}

export function hasStopAffected(affected: SessionAbortAffectedCounts): boolean {
    return Object.values(affected).some((count) => count > 0);
}

export function stopReceipt(
    input: ExactSessionStopInput,
    outcome: SessionStopOutcome,
    affected: SessionAbortAffectedCounts,
): SessionStopReceipt {
    return { outcome, requestId: input.requestId, operationId: input.operationId, affected };
}

export function failedStopReceipt(
    input: ExactSessionStopInput,
    errorCode: SessionStopErrorCode,
    affected: SessionAbortAffectedCounts = EMPTY_STOP_AFFECTED,
): SessionStopReceipt {
    return { ...stopReceipt(input, 'failed', affected), errorCode };
}

export function validateExactStopInput(input: ExactSessionStopInput): void {
    if (
        input.sessionId.length === 0 ||
        input.requestId.length === 0 ||
        input.operationId.length === 0 ||
        input.ownerId.length === 0 ||
        !Number.isSafeInteger(input.ownerEpoch) ||
        input.ownerEpoch < 1 ||
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs < 0
    ) {
        throw new TypeError('invalid exact-session stop input');
    }
}

function latestApprovalRecord(events: readonly AgentEvent[], approvalId: string) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const record = events[index]?.approvalRecord;
        if (record?.approvalId === approvalId) return record;
    }
    return undefined;
}

function delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
