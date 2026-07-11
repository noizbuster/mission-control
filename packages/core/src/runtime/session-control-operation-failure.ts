import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db.js';
import type { SessionControlLease } from './session-control-lease.js';
import {
    isLiveOperationLease,
    runSessionControlOperationImmediate,
    selectSessionControlOperation,
} from './session-control-operation-sql.js';
import { assertOperationWallTime, SESSION_CONTROL_SETTLED_RETENTION_MS } from './session-control-operation-types.js';

export async function failSessionControlOperation(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly operationId: string;
    readonly receipt: unknown;
    readonly barrierReleasedAt: number;
    readonly nowWallMs: number;
}): Promise<{ readonly transitioned: boolean; readonly receipt: unknown }> {
    if (input.operationId.length === 0) throw new TypeError('operation id must be nonempty');
    assertOperationWallTime(input.barrierReleasedAt);
    assertOperationWallTime(input.nowWallMs);
    return runSessionControlOperationImmediate(input.runtime, async (client) => {
        const operation = await selectSessionControlOperation(
            client,
            input.lease.dbIdentity,
            input.lease.sessionId,
            input.operationId,
        );
        if (operation === undefined) throw new Error(`unknown session control operation: ${input.operationId}`);
        if (operation.status !== 'active') return { transitioned: false, receipt: operation.receipt };
        if (operation.ownerId !== input.lease.ownerId || operation.ownerEpoch !== input.lease.epoch) {
            throw new Error('session control operation failure owner epoch mismatch');
        }
        if (!(await isLiveOperationLease(client, input.lease, input.nowWallMs))) {
            throw new Error('session control operation failure lost its lease fence');
        }
        await writeFailedOperation(client, operation, input);
        return { transitioned: true, receipt: input.receipt };
    });
}

export async function failSessionControlOperationAfterFenceLoss(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly operationId: string;
    readonly receipt: unknown;
    readonly barrierReleasedAt: number;
    readonly nowWallMs: number;
}): Promise<{ readonly transitioned: boolean; readonly receipt: unknown }> {
    if (input.operationId.length === 0) throw new TypeError('operation id must be nonempty');
    assertOperationWallTime(input.barrierReleasedAt);
    assertOperationWallTime(input.nowWallMs);
    return runSessionControlOperationImmediate(input.runtime, async (client) => {
        const operation = await selectSessionControlOperation(
            client,
            input.lease.dbIdentity,
            input.lease.sessionId,
            input.operationId,
        );
        if (operation === undefined) throw new Error(`unknown session control operation: ${input.operationId}`);
        if (operation.status !== 'active') return { transitioned: false, receipt: operation.receipt };
        if (operation.ownerId !== input.lease.ownerId || operation.ownerEpoch !== input.lease.epoch) {
            throw new Error('session control operation fence-loss owner epoch mismatch');
        }
        await writeFailedOperation(client, operation, input);
        return { transitioned: true, receipt: input.receipt };
    });
}

async function writeFailedOperation(
    client: Parameters<typeof selectSessionControlOperation>[0],
    operation: NonNullable<Awaited<ReturnType<typeof selectSessionControlOperation>>>,
    input: { readonly receipt: unknown; readonly barrierReleasedAt: number; readonly nowWallMs: number },
): Promise<void> {
    await client.execute({
        sql:
            "UPDATE session_control_operations SET status = 'failed', receipt_json = ?, barrier_released_at = ?, " +
            'terminal_at = ?, retention_until = ? WHERE db_identity = ? AND session_id = ? AND operation_id = ? ' +
            "AND owner_id = ? AND owner_epoch = ? AND status = 'active'",
        args: [
            JSON.stringify(input.receipt),
            input.barrierReleasedAt,
            input.nowWallMs,
            input.nowWallMs + SESSION_CONTROL_SETTLED_RETENTION_MS,
            operation.dbIdentity,
            operation.sessionId,
            operation.operationId,
            operation.ownerId,
            operation.ownerEpoch,
        ],
    });
}
