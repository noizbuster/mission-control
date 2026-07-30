import type { Client } from '@libsql/client';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import { sessionControlLeases, sessionControlOperations } from '../db/schema';
import {
    insertSessionControlLease,
    replaceExpiredSessionControlLease,
    runSessionControlLeaseImmediate,
    selectSessionControlLease,
} from './session-control-lease-sql';
import { SESSION_CONTROL_DEAD_LEASE_RETENTION_MS } from './session-control-operation-types';

export const SESSION_CONTROL_LEASE_TTL_MS = 15_000;

export type SessionControlLease = {
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly epoch: number;
    readonly nonceHash: string;
    readonly pid: number;
    readonly processStartId: string;
    readonly heartbeatWallMs: number;
    readonly expiresWallMs: number;
};

export type SessionControlLeaseAcquisition = {
    readonly lease: SessionControlLease;
    readonly previous?: SessionControlLease;
};

export type SessionControlLeaseErrorCode = 'invalid_lease' | 'lease_fenced' | 'session_owned_elsewhere';

export class SessionControlLeaseError extends Error {
    readonly code: SessionControlLeaseErrorCode;

    constructor(code: SessionControlLeaseErrorCode, message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'SessionControlLeaseError';
        this.code = code;
    }
}

type AcquireSessionControlLeaseInput = {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly nonceHash: string;
    readonly pid: number;
    readonly processStartId: string;
    readonly nowWallMs: number;
    readonly ttlMs?: number;
};

type LeaseActionInput = {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly nowWallMs: number;
    readonly ttlMs?: number;
};

export async function acquireSessionControlLease(
    input: AcquireSessionControlLeaseInput,
): Promise<SessionControlLeaseAcquisition> {
    validateAcquireInput(input);
    return runSessionControlLeaseImmediate(input.runtime, async (client) => {
        const previous = await selectSessionControlLease(client, input.dbIdentity, input.sessionId);
        if (previous !== undefined && previous.expiresWallMs > input.nowWallMs) {
            throw new SessionControlLeaseError(
                'session_owned_elsewhere',
                'The session already has a live control owner',
            );
        }
        const lease: SessionControlLease = {
            dbIdentity: input.dbIdentity,
            sessionId: input.sessionId,
            ownerId: input.ownerId,
            epoch: (previous?.epoch ?? 0) + 1,
            nonceHash: input.nonceHash,
            pid: input.pid,
            processStartId: input.processStartId,
            heartbeatWallMs: input.nowWallMs,
            expiresWallMs: input.nowWallMs + (input.ttlMs ?? SESSION_CONTROL_LEASE_TTL_MS),
        };
        const result =
            previous === undefined
                ? await insertSessionControlLease(client, lease)
                : await replaceExpiredSessionControlLease(client, lease, previous, input.nowWallMs);
        if (result.rowsAffected !== 1) {
            throw new SessionControlLeaseError('lease_fenced', 'The control lease acquisition lost its epoch race');
        }
        return previous === undefined ? { lease } : { lease, previous };
    });
}

export async function renewSessionControlLease(input: LeaseActionInput): Promise<SessionControlLease | undefined> {
    validateLease(input.lease);
    assertWallTime(input.nowWallMs);
    return runSessionControlLeaseImmediate(input.runtime, async (client) => {
        const expiresWallMs = input.nowWallMs + (input.ttlMs ?? SESSION_CONTROL_LEASE_TTL_MS);
        const db = drizzleFromClient(client);
        const result = await db
            .update(sessionControlLeases)
            .set({
                heartbeatWallMs: input.nowWallMs,
                expiresWallMs,
            })
            .where(
                and(
                    eq(sessionControlLeases.dbIdentity, input.lease.dbIdentity),
                    eq(sessionControlLeases.sessionId, input.lease.sessionId),
                    eq(sessionControlLeases.ownerId, input.lease.ownerId),
                    eq(sessionControlLeases.epoch, input.lease.epoch),
                    gt(sessionControlLeases.expiresWallMs, input.nowWallMs),
                ),
            );
        if (result.rowsAffected === 1) {
            await extendActiveOperationRetention(
                db,
                input.lease,
                expiresWallMs + SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
            );
        }
        return result.rowsAffected === 1
            ? { ...input.lease, heartbeatWallMs: input.nowWallMs, expiresWallMs }
            : undefined;
    });
}

/**
 * Re-stamp a lease that this owner still holds after a transient heartbeat miss.
 *
 * `renewSessionControlLease` refuses to touch a lease whose `expires_wall_ms` has
 * already passed, so a heartbeat renewal delayed past the TTL (write-lane backlog
 * or event-loop saturation during a long graph fan-out) returns `undefined` and the
 * renewer fences the run — killing long interactive sessions even though the owning
 * process is still alive and no takeover occurred.
 *
 * `reclaimSessionControlLease` drops only the expiry guard: it re-stamps
 * `heartbeat_wall_ms`/`expires_wall_ms` for the SAME `owner_id` + `epoch`. A
 * genuinely dead process cannot reach this code, so only an alive-but-starved owner
 * reclaims its own lease. If another process took over (different `owner_id`/
 * `epoch`) the row no longer matches and this returns `undefined`, so the caller
 * fences — preserving takeover safety.
 */
export async function reclaimSessionControlLease(input: LeaseActionInput): Promise<SessionControlLease | undefined> {
    validateLease(input.lease);
    assertWallTime(input.nowWallMs);
    return runSessionControlLeaseImmediate(input.runtime, async (client) => {
        const expiresWallMs = input.nowWallMs + (input.ttlMs ?? SESSION_CONTROL_LEASE_TTL_MS);
        const db = drizzleFromClient(client);
        const result = await db
            .update(sessionControlLeases)
            .set({
                heartbeatWallMs: input.nowWallMs,
                expiresWallMs,
            })
            .where(
                and(
                    eq(sessionControlLeases.dbIdentity, input.lease.dbIdentity),
                    eq(sessionControlLeases.sessionId, input.lease.sessionId),
                    eq(sessionControlLeases.ownerId, input.lease.ownerId),
                    eq(sessionControlLeases.epoch, input.lease.epoch),
                ),
            );
        if (result.rowsAffected !== 1) return undefined;
        await extendActiveOperationRetention(
            db,
            input.lease,
            expiresWallMs + SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
        );
        return { ...input.lease, heartbeatWallMs: input.nowWallMs, expiresWallMs };
    });
}

export async function expireSessionControlLease(input: LeaseActionInput): Promise<boolean> {
    validateLease(input.lease);
    assertWallTime(input.nowWallMs);
    return runSessionControlLeaseImmediate(input.runtime, async (client) => {
        const db = drizzleFromClient(client);
        const result = await db
            .update(sessionControlLeases)
            .set({ expiresWallMs: input.nowWallMs })
            .where(
                and(
                    eq(sessionControlLeases.dbIdentity, input.lease.dbIdentity),
                    eq(sessionControlLeases.sessionId, input.lease.sessionId),
                    eq(sessionControlLeases.ownerId, input.lease.ownerId),
                    eq(sessionControlLeases.epoch, input.lease.epoch),
                ),
            );
        if (result.rowsAffected === 1) {
            await extendActiveOperationRetention(
                db,
                input.lease,
                input.nowWallMs + SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
            );
        }
        return result.rowsAffected === 1;
    });
}

export async function runWithSessionControlLeaseFence<T>(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly nowWallMs: number;
    readonly write: (client: Client) => Promise<T>;
}): Promise<T> {
    validateLease(input.lease);
    assertWallTime(input.nowWallMs);
    return runSessionControlLeaseImmediate(input.runtime, async (client) => {
        const current = await selectSessionControlLease(client, input.lease.dbIdentity, input.lease.sessionId);
        if (
            current === undefined ||
            current.ownerId !== input.lease.ownerId ||
            current.epoch !== input.lease.epoch ||
            current.expiresWallMs <= input.nowWallMs
        ) {
            throw new SessionControlLeaseError('lease_fenced', 'The control owner no longer holds a live lease');
        }
        return input.write(client);
    });
}

export async function readSessionControlLease(
    runtime: LocalLibsqlWriteTarget,
    dbIdentity: string,
    sessionId: string,
): Promise<SessionControlLease | undefined> {
    return selectSessionControlLease(runtime.client, dbIdentity, sessionId);
}

async function extendActiveOperationRetention(
    db: ReturnType<typeof drizzleFromClient>,
    lease: SessionControlLease,
    retentionUntil: number,
): Promise<void> {
    await db
        .update(sessionControlOperations)
        .set({ retentionUntil })
        .where(
            and(
                eq(sessionControlOperations.dbIdentity, lease.dbIdentity),
                eq(sessionControlOperations.sessionId, lease.sessionId),
                eq(sessionControlOperations.ownerId, lease.ownerId),
                eq(sessionControlOperations.ownerEpoch, lease.epoch),
                inArray(sessionControlOperations.status, ['active', 'timed_out']),
            ),
        );
}

function validateAcquireInput(input: AcquireSessionControlLeaseInput): void {
    validateLease({
        dbIdentity: input.dbIdentity,
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        epoch: 1,
        nonceHash: input.nonceHash,
        pid: input.pid,
        processStartId: input.processStartId,
        heartbeatWallMs: input.nowWallMs,
        expiresWallMs: input.nowWallMs + (input.ttlMs ?? SESSION_CONTROL_LEASE_TTL_MS),
    });
}

function validateLease(lease: SessionControlLease): void {
    if (
        !/^[0-9a-f]{64}$/u.test(lease.dbIdentity) ||
        !/^[0-9a-f]{64}$/u.test(lease.nonceHash) ||
        lease.sessionId.length === 0 ||
        lease.ownerId.length === 0 ||
        lease.processStartId.length === 0 ||
        !Number.isSafeInteger(lease.epoch) ||
        lease.epoch < 1 ||
        !Number.isSafeInteger(lease.pid) ||
        lease.pid < 0
    ) {
        throw new SessionControlLeaseError('invalid_lease', 'Invalid session control lease identity');
    }
    assertWallTime(lease.heartbeatWallMs);
    assertWallTime(lease.expiresWallMs);
}

function assertWallTime(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new SessionControlLeaseError('invalid_lease', 'Invalid session control lease wall time');
    }
}
