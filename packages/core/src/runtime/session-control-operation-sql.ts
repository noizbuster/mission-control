import type { Client, Row } from '@libsql/client';
import { z } from 'zod';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import type { SessionControlLease } from './session-control-lease';
import { runSessionControlLeaseImmediate } from './session-control-lease-sql';
import type { SessionControlOperation } from './session-control-operation-types';

const operationRowSchema = z.object({
    db_identity: z.string(),
    session_id: z.string(),
    operation_id: z.string(),
    owner_id: z.string(),
    owner_epoch: z.number().int().positive(),
    barrier_kind: z.enum(['all_mutations', 'child_spawn_only']),
    status: z.enum(['active', 'completed', 'failed', 'timed_out']),
    deadline_wall_ms: z.number().int().nonnegative(),
    receipt_json: z.string().nullable(),
    captured_handle_ids_json: z.string(),
    settled_handle_ids_json: z.string(),
    barrier_released_at: z.number().int().nonnegative().nullable(),
    created_at: z.number().int().nonnegative(),
    terminal_at: z.number().int().nonnegative().nullable(),
    retention_until: z.number().int().nonnegative(),
});

const stringArraySchema = z.array(z.string().min(1));

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
    const result = await client.execute({
        sql:
            'SELECT * FROM session_control_operations ' +
            'WHERE db_identity = ? AND session_id = ? AND operation_id = ?',
        args: [dbIdentity, sessionId, operationId],
    });
    const row = result.rows[0];
    return row === undefined ? undefined : operationFromRow(row);
}

export async function insertSessionControlOperation(client: Client, operation: SessionControlOperation): Promise<void> {
    await client.execute({
        sql:
            'INSERT INTO session_control_operations ' +
            '(db_identity,session_id,operation_id,owner_id,owner_epoch,barrier_kind,status,deadline_wall_ms,' +
            'receipt_json,captured_handle_ids_json,settled_handle_ids_json,barrier_released_at,created_at,terminal_at,retention_until) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        args: [
            operation.dbIdentity,
            operation.sessionId,
            operation.operationId,
            operation.ownerId,
            operation.ownerEpoch,
            operation.barrierKind,
            operation.status,
            operation.deadlineWallMs,
            operation.receipt === null ? null : JSON.stringify(operation.receipt),
            JSON.stringify(operation.capturedHandleIds),
            JSON.stringify(operation.settledHandleIds),
            operation.barrierReleasedAt,
            operation.createdAt,
            operation.terminalAt,
            operation.retentionUntil,
        ],
    });
}

export async function isLiveOperationLease(
    client: Client,
    lease: SessionControlLease,
    nowWallMs: number,
): Promise<boolean> {
    const result = await client.execute({
        sql:
            'SELECT 1 FROM session_control_leases WHERE db_identity = ? AND session_id = ? ' +
            'AND owner_id = ? AND epoch = ? AND expires_wall_ms > ?',
        args: [lease.dbIdentity, lease.sessionId, lease.ownerId, lease.epoch, nowWallMs],
    });
    return result.rows.length === 1;
}

export function operationFromRow(row: Row): SessionControlOperation {
    const parsed = operationRowSchema.parse(row);
    return {
        dbIdentity: parsed.db_identity,
        sessionId: parsed.session_id,
        operationId: parsed.operation_id,
        ownerId: parsed.owner_id,
        ownerEpoch: parsed.owner_epoch,
        barrierKind: parsed.barrier_kind,
        status: parsed.status,
        deadlineWallMs: parsed.deadline_wall_ms,
        receipt: parsed.receipt_json === null ? null : JSON.parse(parsed.receipt_json),
        capturedHandleIds: stringArraySchema.parse(JSON.parse(parsed.captured_handle_ids_json)),
        settledHandleIds: stringArraySchema.parse(JSON.parse(parsed.settled_handle_ids_json)),
        barrierReleasedAt: parsed.barrier_released_at,
        createdAt: parsed.created_at,
        terminalAt: parsed.terminal_at,
        retentionUntil: parsed.retention_until,
    };
}
