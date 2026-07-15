import type { Client } from '@libsql/client';
import type { SessionStopBarrierKind } from '@mission-control/protocol';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import type { SessionControlLease } from './session-control-lease';
import {
    insertSessionControlOperation,
    isLiveOperationLease,
    operationFromRow,
    runSessionControlOperationImmediate,
    selectSessionControlOperation,
} from './session-control-operation-sql';
import {
    assertOperationWallTime,
    SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
    SESSION_CONTROL_SETTLED_RETENTION_MS,
    type SessionControlOperation,
} from './session-control-operation-types';

export * from './session-control-operation-failure';
export * from './session-control-operation-gc';
export * from './session-control-operation-settlement';
export * from './session-control-operation-types';

type OperationIdentity = {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly operationId: string;
};

export async function createSessionControlOperation(
    input: OperationIdentity & {
        readonly barrierKind: SessionStopBarrierKind;
        readonly deadlineWallMs: number;
        readonly capturedHandleIds: readonly string[];
        readonly nowWallMs: number;
    },
): Promise<SessionControlOperation> {
    validateIdentity(input);
    assertOperationWallTime(input.deadlineWallMs);
    assertOperationWallTime(input.nowWallMs);
    const capturedHandleIds = uniqueHandleIds(input.capturedHandleIds);
    return runSessionControlOperationImmediate(input.runtime, async (client) => {
        if (!(await isLiveOperationLease(client, input.lease, input.nowWallMs))) {
            throw new Error('session control operation creation requires a live matching lease');
        }
        const operation: SessionControlOperation = {
            dbIdentity: input.lease.dbIdentity,
            sessionId: input.lease.sessionId,
            operationId: input.operationId,
            ownerId: input.lease.ownerId,
            ownerEpoch: input.lease.epoch,
            barrierKind: input.barrierKind,
            status: 'active',
            deadlineWallMs: input.deadlineWallMs,
            receipt: null,
            capturedHandleIds,
            settledHandleIds: [],
            barrierReleasedAt: null,
            createdAt: input.nowWallMs,
            terminalAt: null,
            retentionUntil: input.lease.expiresWallMs + SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
        };
        await insertSessionControlOperation(client, operation);
        return operation;
    });
}

export function readSessionControlOperation(
    runtime: LocalLibsqlWriteTarget,
    dbIdentity: string,
    sessionId: string,
    operationId: string,
): Promise<SessionControlOperation | undefined> {
    return selectSessionControlOperation(runtime.client, dbIdentity, sessionId, operationId);
}

export async function completeSessionControlOperation(
    input: OperationIdentity & {
        readonly status: 'completed' | 'failed';
        readonly receipt: unknown;
        readonly barrierReleasedAt: number;
        readonly nowWallMs: number;
    },
): Promise<void> {
    validateIdentity(input);
    assertOperationWallTime(input.barrierReleasedAt);
    assertOperationWallTime(input.nowWallMs);
    await runSessionControlOperationImmediate(input.runtime, async (client) => {
        await completeSessionControlOperationWithClient(client, input);
    });
}

export async function completeSessionControlOperationWithClient(
    client: Client,
    input: Omit<Parameters<typeof completeSessionControlOperation>[0], 'runtime'>,
): Promise<void> {
    validateIdentity(input);
    assertOperationWallTime(input.barrierReleasedAt);
    assertOperationWallTime(input.nowWallMs);
    const operation = await requireActiveOperation(client, input);
    if (!(await isLiveOperationLease(client, input.lease, input.nowWallMs))) {
        throw new Error('session control operation completion lost its lease fence');
    }
    if (!allHandlesSettled(operation)) {
        throw new Error('session control operation cannot complete before every captured handle settles');
    }
    await client.execute({
        sql:
            'UPDATE session_control_operations SET status = ?, receipt_json = ?, barrier_released_at = ?, ' +
            "terminal_at = ?, retention_until = ? WHERE db_identity = ? AND session_id = ? AND operation_id = ? AND status = 'active'",
        args: [
            input.status,
            JSON.stringify(input.receipt),
            input.barrierReleasedAt,
            input.nowWallMs,
            input.nowWallMs + SESSION_CONTROL_SETTLED_RETENTION_MS,
            operation.dbIdentity,
            operation.sessionId,
            operation.operationId,
        ],
    });
}

export async function timeoutSessionControlOperation(
    input: OperationIdentity & {
        readonly receipt: unknown;
        readonly barrierReleasedAt: number;
        readonly nowWallMs: number;
        readonly releaseBarrier: () => void | Promise<void>;
    },
): Promise<{ readonly transitioned: boolean; readonly receipt: unknown }> {
    validateIdentity(input);
    assertOperationWallTime(input.barrierReleasedAt);
    assertOperationWallTime(input.nowWallMs);
    const result = await runSessionControlOperationImmediate(input.runtime, async (client) => {
        const operation = await requireOperation(client, input);
        if (operation.status !== 'active') return { transitioned: false, receipt: operation.receipt };
        if (operation.ownerId !== input.lease.ownerId || operation.ownerEpoch !== input.lease.epoch) {
            throw new Error('session control operation timeout owner epoch mismatch');
        }
        await writeTimeout(client, operation, input.receipt, input.barrierReleasedAt, input.nowWallMs);
        return { transitioned: true, receipt: input.receipt };
    });
    if (result.transitioned) await input.releaseBarrier();
    return result;
}

export async function recoverExpiredSessionControlOperations(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly nowWallMs: number;
    readonly releaseBarrier?: (operationId: string) => void | Promise<void>;
}): Promise<readonly string[]> {
    assertOperationWallTime(input.nowWallMs);
    const operationIds = await runSessionControlOperationImmediate(input.runtime, async (client) => {
        const result = await client.execute({
            sql: "SELECT * FROM session_control_operations WHERE status = 'active' AND deadline_wall_ms <= ?",
            args: [input.nowWallMs],
        });
        const expired = result.rows.map(operationFromRow);
        for (const operation of expired) {
            await writeTimeout(
                client,
                operation,
                { outcome: 'failed', errorCode: 'stop_timeout' },
                input.nowWallMs,
                input.nowWallMs,
            );
        }
        return expired.map((operation) => operation.operationId);
    });
    for (const operationId of operationIds) await input.releaseBarrier?.(operationId);
    return operationIds;
}

async function requireOperation(
    client: Client,
    input: Pick<OperationIdentity, 'lease' | 'operationId'>,
): Promise<SessionControlOperation> {
    const operation = await selectSessionControlOperation(
        client,
        input.lease.dbIdentity,
        input.lease.sessionId,
        input.operationId,
    );
    if (operation === undefined) throw new Error(`unknown session control operation: ${input.operationId}`);
    return operation;
}

async function requireActiveOperation(
    client: Client,
    input: Pick<OperationIdentity, 'lease' | 'operationId'>,
): Promise<SessionControlOperation> {
    const operation = await requireOperation(client, input);
    if (operation.status !== 'active') throw new Error(`session control operation is terminal: ${input.operationId}`);
    if (operation.ownerId !== input.lease.ownerId || operation.ownerEpoch !== input.lease.epoch) {
        throw new Error('session control operation owner epoch mismatch');
    }
    return operation;
}

async function writeTimeout(
    client: Client,
    operation: SessionControlOperation,
    receipt: unknown,
    barrierReleasedAt: number,
    terminalAt: number,
): Promise<void> {
    await client.execute({
        sql:
            "UPDATE session_control_operations SET status = 'timed_out', receipt_json = ?, barrier_released_at = ?, " +
            "terminal_at = ? WHERE db_identity = ? AND session_id = ? AND operation_id = ? AND status = 'active'",
        args: [
            JSON.stringify(receipt),
            barrierReleasedAt,
            terminalAt,
            operation.dbIdentity,
            operation.sessionId,
            operation.operationId,
        ],
    });
}

function allHandlesSettled(operation: SessionControlOperation): boolean {
    return operation.capturedHandleIds.every((id) => operation.settledHandleIds.includes(id));
}

function uniqueHandleIds(handleIds: readonly string[]): readonly string[] {
    for (const handleId of handleIds) assertNonempty(handleId, 'captured handle id');
    if (new Set(handleIds).size !== handleIds.length) throw new TypeError('captured handle ids must be unique');
    return [...handleIds];
}

function validateIdentity(input: Pick<OperationIdentity, 'operationId'>): void {
    assertNonempty(input.operationId, 'operation id');
}

function assertNonempty(value: string, label: string): void {
    if (value.length === 0) throw new TypeError(`${label} must not be empty`);
}
