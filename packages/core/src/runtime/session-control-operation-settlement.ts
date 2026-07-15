import type { Client } from '@libsql/client';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import type { SessionControlCallbackFence } from './session-control-cancellation';
import type { SessionControlLease } from './session-control-lease';
import {
    isLiveOperationLease,
    runSessionControlOperationImmediate,
    selectSessionControlOperation,
} from './session-control-operation-sql';
import {
    assertOperationWallTime,
    redactLateSettlementMetadata,
    SESSION_CONTROL_SETTLED_RETENTION_MS,
    type SessionControlOperation,
} from './session-control-operation-types';
import { randomUUID } from 'node:crypto';

type HandleSettlementInput = {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly operationId: string;
    readonly handleKind: string;
    readonly handleId: string;
    readonly attemptedEventType: string;
    readonly nowWallMs: number;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly lateId?: string;
    readonly write?: (client: Client) => Promise<void>;
};

export async function settleSessionControlOperationHandle(
    input: HandleSettlementInput,
): Promise<{ readonly accepted: boolean; readonly allSettled: boolean }> {
    assertNonempty(input.operationId, 'operation id');
    assertNonempty(input.handleKind, 'handle kind');
    assertNonempty(input.handleId, 'handle id');
    assertNonempty(input.attemptedEventType, 'attempted event type');
    assertOperationWallTime(input.nowWallMs);
    return runSessionControlOperationImmediate(input.runtime, async (client) => {
        const operation = await selectSessionControlOperation(
            client,
            input.lease.dbIdentity,
            input.lease.sessionId,
            input.operationId,
        );
        if (operation !== undefined && acceptsTimedOutSettlement(operation, input)) {
            return settleTimedOutOperation(client, operation, input);
        }
        if (!(await acceptsSettlement(client, operation, input))) {
            await quarantineSettlement(client, input);
            return { accepted: false, allSettled: false };
        }
        if (operation === undefined) throw new Error('accepted settlement is missing its operation');
        if (operation.settledHandleIds.includes(input.handleId)) {
            return { accepted: true, allSettled: allHandlesSettled(operation) };
        }
        await input.write?.(client);
        const settledHandleIds = [...operation.settledHandleIds, input.handleId];
        await client.execute({
            sql:
                'UPDATE session_control_operations SET settled_handle_ids_json = ? ' +
                "WHERE db_identity = ? AND session_id = ? AND operation_id = ? AND status = 'active'",
            args: [JSON.stringify(settledHandleIds), operation.dbIdentity, operation.sessionId, operation.operationId],
        });
        return { accepted: true, allSettled: operation.capturedHandleIds.every((id) => settledHandleIds.includes(id)) };
    });
}

export function createSessionControlCallbackFence(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly operationId: string;
    readonly nowWallMs?: () => number;
}): SessionControlCallbackFence {
    return {
        operationId: input.operationId,
        settle: (attempt) =>
            settleSessionControlOperationHandle({
                runtime: input.runtime,
                lease: input.lease,
                operationId: input.operationId,
                handleKind: attempt.handleKind,
                handleId: attempt.handleId,
                attemptedEventType: attempt.attemptedEventType,
                nowWallMs: input.nowWallMs?.() ?? Date.now(),
                metadata: attempt.metadata,
                ...(attempt.write !== undefined ? { write: attempt.write } : {}),
            }),
    };
}

async function acceptsSettlement(
    client: Client,
    operation: SessionControlOperation | undefined,
    input: HandleSettlementInput,
): Promise<boolean> {
    return (
        operation !== undefined &&
        operation.status === 'active' &&
        operation.ownerId === input.lease.ownerId &&
        operation.ownerEpoch === input.lease.epoch &&
        operation.capturedHandleIds.includes(input.handleId) &&
        (await isLiveOperationLease(client, input.lease, input.nowWallMs))
    );
}

async function quarantineSettlement(client: Client, input: HandleSettlementInput): Promise<void> {
    await client.execute({
        sql:
            'INSERT INTO session_control_late_settlements ' +
            '(late_id,db_identity,session_id,operation_id,owner_epoch,handle_kind,handle_id,attempted_event_type,observed_at,metadata_json) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?)',
        args: [
            input.lateId ?? randomUUID(),
            input.lease.dbIdentity,
            input.lease.sessionId,
            input.operationId,
            input.lease.epoch,
            input.handleKind,
            input.handleId,
            input.attemptedEventType,
            input.nowWallMs,
            JSON.stringify(redactLateSettlementMetadata(input.metadata)),
        ],
    });
}

function acceptsTimedOutSettlement(operation: SessionControlOperation, input: HandleSettlementInput): boolean {
    return (
        operation.status === 'timed_out' &&
        operation.ownerId === input.lease.ownerId &&
        operation.ownerEpoch === input.lease.epoch &&
        operation.capturedHandleIds.includes(input.handleId)
    );
}

async function settleTimedOutOperation(
    client: Client,
    operation: SessionControlOperation,
    input: HandleSettlementInput,
): Promise<{ readonly accepted: false; readonly allSettled: boolean }> {
    await quarantineSettlement(client, input);
    const settledHandleIds = operation.settledHandleIds.includes(input.handleId)
        ? operation.settledHandleIds
        : [...operation.settledHandleIds, input.handleId];
    const allSettled = operation.capturedHandleIds.every((id) => settledHandleIds.includes(id));
    await client.execute({
        sql:
            'UPDATE session_control_operations SET settled_handle_ids_json = ?, retention_until = ? ' +
            "WHERE db_identity = ? AND session_id = ? AND operation_id = ? AND status = 'timed_out'",
        args: [
            JSON.stringify(settledHandleIds),
            allSettled ? input.nowWallMs + SESSION_CONTROL_SETTLED_RETENTION_MS : operation.retentionUntil,
            operation.dbIdentity,
            operation.sessionId,
            operation.operationId,
        ],
    });
    return { accepted: false, allSettled };
}

function allHandlesSettled(operation: SessionControlOperation): boolean {
    return operation.capturedHandleIds.every((id) => operation.settledHandleIds.includes(id));
}

function assertNonempty(value: string, label: string): void {
    if (value.length === 0) throw new TypeError(`${label} must not be empty`);
}
