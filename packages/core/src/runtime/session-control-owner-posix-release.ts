import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db.js';
import type { SessionControlLease } from './session-control-lease.js';
import { runSessionControlLeaseImmediate } from './session-control-lease-sql.js';
import { SESSION_CONTROL_DEAD_LEASE_RETENTION_MS } from './session-control-operation-types.js';

export async function releaseSessionControlOwnerLease(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly nowWallMs: number;
}): Promise<boolean> {
    return runSessionControlLeaseImmediate(input.runtime, async (client) => {
        const result = await client.execute({
            sql:
                'UPDATE session_control_leases SET heartbeat_wall_ms = ?, expires_wall_ms = ?, process_start_id = ? ' +
                'WHERE db_identity = ? AND session_id = ? AND owner_id = ? AND epoch = ?',
            args: [
                input.nowWallMs,
                input.nowWallMs,
                `released:${input.lease.ownerId}:${input.lease.epoch}`,
                input.lease.dbIdentity,
                input.lease.sessionId,
                input.lease.ownerId,
                input.lease.epoch,
            ],
        });
        if (result.rowsAffected === 1) {
            await client.execute({
                sql:
                    'UPDATE session_control_operations SET retention_until = ? ' +
                    "WHERE db_identity = ? AND session_id = ? AND owner_id = ? AND owner_epoch = ? AND status IN ('active','timed_out')",
                args: [
                    input.nowWallMs + SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
                    input.lease.dbIdentity,
                    input.lease.sessionId,
                    input.lease.ownerId,
                    input.lease.epoch,
                ],
            });
        }
        return result.rowsAffected === 1;
    });
}
