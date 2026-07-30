import { and, eq, inArray } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import { sessionControlLeases, sessionControlOperations } from '../db/schema';
import type { SessionControlLease } from './session-control-lease';
import { runSessionControlLeaseImmediate } from './session-control-lease-sql';
import { SESSION_CONTROL_DEAD_LEASE_RETENTION_MS } from './session-control-operation-types';

export async function releaseSessionControlOwnerLease(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly nowWallMs: number;
}): Promise<boolean> {
    return runSessionControlLeaseImmediate(input.runtime, async (client) => {
        const db = drizzleFromClient(client);
        const result = await db
            .update(sessionControlLeases)
            .set({
                heartbeatWallMs: input.nowWallMs,
                expiresWallMs: input.nowWallMs,
                processStartId: `released:${input.lease.ownerId}:${input.lease.epoch}`,
            })
            .where(
                and(
                    eq(sessionControlLeases.dbIdentity, input.lease.dbIdentity),
                    eq(sessionControlLeases.sessionId, input.lease.sessionId),
                    eq(sessionControlLeases.ownerId, input.lease.ownerId),
                    eq(sessionControlLeases.epoch, input.lease.epoch),
                ),
            );
        if (result.rowsAffected === 1) {
            await db
                .update(sessionControlOperations)
                .set({ retentionUntil: input.nowWallMs + SESSION_CONTROL_DEAD_LEASE_RETENTION_MS })
                .where(
                    and(
                        eq(sessionControlOperations.dbIdentity, input.lease.dbIdentity),
                        eq(sessionControlOperations.sessionId, input.lease.sessionId),
                        eq(sessionControlOperations.ownerId, input.lease.ownerId),
                        eq(sessionControlOperations.ownerEpoch, input.lease.epoch),
                        inArray(sessionControlOperations.status, ['active', 'timed_out']),
                    ),
                );
        }
        return result.rowsAffected === 1;
    });
}
