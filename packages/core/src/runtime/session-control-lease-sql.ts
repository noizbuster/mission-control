import type { Client } from '@libsql/client';
import { z } from 'zod';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import type { SessionControlLease } from './session-control-lease.js';

const leaseRowSchema = z.object({
    db_identity: z.string(),
    session_id: z.string(),
    owner_id: z.string(),
    epoch: z.number().int().positive(),
    nonce_hash: z.string(),
    pid: z.number().int().nonnegative(),
    process_start_id: z.string(),
    heartbeat_wall_ms: z.number().int().nonnegative(),
    expires_wall_ms: z.number().int().nonnegative(),
});

export async function runSessionControlLeaseImmediate<T>(
    runtime: LocalLibsqlWriteTarget,
    action: (client: Client) => Promise<T>,
): Promise<T> {
    return runLocalLibsqlWrite(runtime, async (client) => {
        await client.execute('BEGIN IMMEDIATE TRANSACTION');
        try {
            const result = await action(client);
            await client.execute('COMMIT');
            return result;
        } catch (error: unknown) {
            await rollbackQuietly(client);
            throw error;
        }
    });
}

export async function selectSessionControlLease(
    client: Client,
    dbIdentity: string,
    sessionId: string,
): Promise<SessionControlLease | undefined> {
    const result = await client.execute({
        sql: 'SELECT * FROM session_control_leases WHERE db_identity = ? AND session_id = ?',
        args: [dbIdentity, sessionId],
    });
    const row = result.rows[0];
    return row === undefined ? undefined : leaseFromRow(row);
}

export async function insertSessionControlLease(client: Client, lease: SessionControlLease) {
    return client.execute({
        sql:
            'INSERT INTO session_control_leases ' +
            '(db_identity, session_id, owner_id, epoch, nonce_hash, pid, process_start_id, heartbeat_wall_ms, expires_wall_ms) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: leaseArgs(lease),
    });
}

export async function replaceExpiredSessionControlLease(
    client: Client,
    lease: SessionControlLease,
    previous: SessionControlLease,
    nowWallMs: number,
) {
    return client.execute({
        sql:
            'UPDATE session_control_leases SET owner_id = ?, epoch = ?, nonce_hash = ?, pid = ?, process_start_id = ?, ' +
            'heartbeat_wall_ms = ?, expires_wall_ms = ? WHERE db_identity = ? AND session_id = ? ' +
            'AND owner_id = ? AND epoch = ? AND expires_wall_ms <= ?',
        args: [
            lease.ownerId,
            lease.epoch,
            lease.nonceHash,
            lease.pid,
            lease.processStartId,
            lease.heartbeatWallMs,
            lease.expiresWallMs,
            lease.dbIdentity,
            lease.sessionId,
            previous.ownerId,
            previous.epoch,
            nowWallMs,
        ],
    });
}

function leaseArgs(lease: SessionControlLease): (string | number)[] {
    return [
        lease.dbIdentity,
        lease.sessionId,
        lease.ownerId,
        lease.epoch,
        lease.nonceHash,
        lease.pid,
        lease.processStartId,
        lease.heartbeatWallMs,
        lease.expiresWallMs,
    ];
}

function leaseFromRow(row: unknown): SessionControlLease {
    const parsed = leaseRowSchema.parse(row);
    return {
        dbIdentity: parsed.db_identity,
        sessionId: parsed.session_id,
        ownerId: parsed.owner_id,
        epoch: parsed.epoch,
        nonceHash: parsed.nonce_hash,
        pid: parsed.pid,
        processStartId: parsed.process_start_id,
        heartbeatWallMs: parsed.heartbeat_wall_ms,
        expiresWallMs: parsed.expires_wall_ms,
    };
}

async function rollbackQuietly(client: Client): Promise<void> {
    try {
        await client.execute('ROLLBACK');
    } catch {}
}
