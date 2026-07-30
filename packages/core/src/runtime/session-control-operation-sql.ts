import type { Client } from '@libsql/client';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleFromClient } from '../db/drizzle-client';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import { sessionControlLeases, sessionControlOperations } from '../db/schema';
import type { SessionControlLease } from './session-control-lease';
import { runSessionControlLeaseImmediate } from './session-control-lease-sql';
import type { SessionControlOperation } from './session-control-operation-types';

const stringArraySchema = z.array(z.string().min(1));
const barrierKindSchema = z.enum(['all_mutations', 'child_spawn_only']);
const statusSchema = z.enum(['active', 'completed', 'failed', 'timed_out']);

export function runSessionControlOperationImmediate<T>(
    runtime: LocalLibsqlWriteTarget,
    action: (client: Client) => Promise<T>,
): Promise<T> {
    return runSessionControlLeaseImmediate(runtime, action);
}

export async function selectSessionControlOperation(
    client: Client,
    dbIdentity: string,
    sessionId: string,
    operationId: string,
): Promise<SessionControlOperation | undefined> {
    const db = drizzleFromClient(client);
    const rows = await db
        .select()
        .from(sessionControlOperations)
        .where(
            and(
                eq(sessionControlOperations.dbIdentity, dbIdentity),
                eq(sessionControlOperations.sessionId, sessionId),
                eq(sessionControlOperations.operationId, operationId),
            ),
        )
        .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : operationFromDrizzleRow(row);
}

export async function insertSessionControlOperation(client: Client, operation: SessionControlOperation): Promise<void> {
    const db = drizzleFromClient(client);
    await db.insert(sessionControlOperations).values({
        dbIdentity: operation.dbIdentity,
        sessionId: operation.sessionId,
        operationId: operation.operationId,
        ownerId: operation.ownerId,
        ownerEpoch: operation.ownerEpoch,
        barrierKind: operation.barrierKind,
        status: operation.status,
        deadlineWallMs: operation.deadlineWallMs,
        receiptJson: operation.receipt === null ? null : JSON.stringify(operation.receipt),
        capturedHandleIdsJson: JSON.stringify(operation.capturedHandleIds),
        settledHandleIdsJson: JSON.stringify(operation.settledHandleIds),
        barrierReleasedAt: operation.barrierReleasedAt,
        createdAt: operation.createdAt,
        terminalAt: operation.terminalAt,
        retentionUntil: operation.retentionUntil,
    });
}

export async function isLiveOperationLease(
    client: Client,
    lease: SessionControlLease,
    nowWallMs: number,
): Promise<boolean> {
    const db = drizzleFromClient(client);
    const rows = await db
        .select({ sessionId: sessionControlLeases.sessionId })
        .from(sessionControlLeases)
        .where(
            and(
                eq(sessionControlLeases.dbIdentity, lease.dbIdentity),
                eq(sessionControlLeases.sessionId, lease.sessionId),
                eq(sessionControlLeases.ownerId, lease.ownerId),
                eq(sessionControlLeases.epoch, lease.epoch),
                gt(sessionControlLeases.expiresWallMs, nowWallMs),
            ),
        )
        .limit(1);
    return rows.length === 1;
}

export function operationFromDrizzleRow(row: typeof sessionControlOperations.$inferSelect): SessionControlOperation {
    return {
        dbIdentity: row.dbIdentity,
        sessionId: row.sessionId,
        operationId: row.operationId,
        ownerId: row.ownerId,
        ownerEpoch: row.ownerEpoch,
        barrierKind: barrierKindSchema.parse(row.barrierKind),
        status: statusSchema.parse(row.status),
        deadlineWallMs: row.deadlineWallMs,
        receipt: row.receiptJson === null ? null : JSON.parse(row.receiptJson),
        capturedHandleIds: stringArraySchema.parse(JSON.parse(row.capturedHandleIdsJson)),
        settledHandleIds: stringArraySchema.parse(JSON.parse(row.settledHandleIdsJson)),
        barrierReleasedAt: row.barrierReleasedAt,
        createdAt: row.createdAt,
        terminalAt: row.terminalAt,
        retentionUntil: row.retentionUntil,
    };
}

export function operationFromRow(row: typeof sessionControlOperations.$inferSelect): SessionControlOperation {
    return operationFromDrizzleRow(row);
}
