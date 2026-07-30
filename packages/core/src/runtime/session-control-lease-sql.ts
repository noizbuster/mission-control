import type { Client } from '@libsql/client';
import { and, eq, lte } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction';
import { sessionControlLeases } from '../db/schema';
import type { SessionControlLease } from './session-control-lease';

export async function runSessionControlLeaseImmediate<T>(
    runtime: LocalLibsqlWriteTarget,
    action: (client: Client) => Promise<T>,
): Promise<T> {
    return runLocalLibsqlWrite(runtime, (client) => runLocalLibsqlClientTransaction(client, () => action(client)));
}

export async function selectSessionControlLease(
    client: Client,
    dbIdentity: string,
    sessionId: string,
): Promise<SessionControlLease | undefined> {
    const db = drizzleFromClient(client);
    const rows = await db
        .select()
        .from(sessionControlLeases)
        .where(and(eq(sessionControlLeases.dbIdentity, dbIdentity), eq(sessionControlLeases.sessionId, sessionId)))
        .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : leaseFromDrizzleRow(row);
}

export async function insertSessionControlLease(client: Client, lease: SessionControlLease) {
    const db = drizzleFromClient(client);
    return db.insert(sessionControlLeases).values({
        dbIdentity: lease.dbIdentity,
        sessionId: lease.sessionId,
        ownerId: lease.ownerId,
        epoch: lease.epoch,
        nonceHash: lease.nonceHash,
        pid: lease.pid,
        processStartId: lease.processStartId,
        heartbeatWallMs: lease.heartbeatWallMs,
        expiresWallMs: lease.expiresWallMs,
    });
}

export async function replaceExpiredSessionControlLease(
    client: Client,
    lease: SessionControlLease,
    previous: SessionControlLease,
    nowWallMs: number,
) {
    const db = drizzleFromClient(client);
    return db
        .update(sessionControlLeases)
        .set({
            ownerId: lease.ownerId,
            epoch: lease.epoch,
            nonceHash: lease.nonceHash,
            pid: lease.pid,
            processStartId: lease.processStartId,
            heartbeatWallMs: lease.heartbeatWallMs,
            expiresWallMs: lease.expiresWallMs,
        })
        .where(
            and(
                eq(sessionControlLeases.dbIdentity, lease.dbIdentity),
                eq(sessionControlLeases.sessionId, lease.sessionId),
                eq(sessionControlLeases.ownerId, previous.ownerId),
                eq(sessionControlLeases.epoch, previous.epoch),
                lte(sessionControlLeases.expiresWallMs, nowWallMs),
            ),
        );
}

function leaseFromDrizzleRow(row: typeof sessionControlLeases.$inferSelect): SessionControlLease {
    return {
        dbIdentity: row.dbIdentity,
        sessionId: row.sessionId,
        ownerId: row.ownerId,
        epoch: row.epoch,
        nonceHash: row.nonceHash,
        pid: row.pid,
        processStartId: row.processStartId,
        heartbeatWallMs: row.heartbeatWallMs,
        expiresWallMs: row.expiresWallMs,
    };
}
