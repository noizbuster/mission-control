import type { Client } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import { sessionControlOperations } from '../db/schema';
import type { SessionControlLease } from './session-control-lease';
import {
    isLiveOperationLease,
    runSessionControlOperationImmediate,
    selectSessionControlOperation,
} from './session-control-operation-sql';
import {
    assertOperationWallTime,
    SESSION_CONTROL_SETTLED_RETENTION_MS,
    type SessionControlOperation,
} from './session-control-operation-types';

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
    client: Client,
    operation: SessionControlOperation,
    input: { readonly receipt: unknown; readonly barrierReleasedAt: number; readonly nowWallMs: number },
): Promise<void> {
    const db = drizzleFromClient(client);
    await db
        .update(sessionControlOperations)
        .set({
            status: 'failed',
            receiptJson: JSON.stringify(input.receipt),
            barrierReleasedAt: input.barrierReleasedAt,
            terminalAt: input.nowWallMs,
            retentionUntil: input.nowWallMs + SESSION_CONTROL_SETTLED_RETENTION_MS,
        })
        .where(
            and(
                eq(sessionControlOperations.dbIdentity, operation.dbIdentity),
                eq(sessionControlOperations.sessionId, operation.sessionId),
                eq(sessionControlOperations.operationId, operation.operationId),
                eq(sessionControlOperations.ownerId, operation.ownerId),
                eq(sessionControlOperations.ownerEpoch, operation.ownerEpoch),
                eq(sessionControlOperations.status, 'active'),
            ),
        );
}
