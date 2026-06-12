import { jsonlStoreError } from './jsonl-errors.js';
import {
    jsonlSessionLockPathMatches,
    readJsonlSessionLockIdentity,
    removeJsonlSessionLockPathIfOwned,
} from './jsonl-session-lock-identity.js';
import {
    DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS,
    isStaleInvalidLock,
    isStaleLock,
    type JsonlSessionLockMetadata,
    type JsonlSessionLockReadResult,
    sameLockMetadata,
} from './jsonl-session-lock-metadata.js';
import { readExistingJsonlSessionLock, removeClaimedJsonlSessionLockPath } from './jsonl-session-lock-reader.js';
import { randomUUID } from 'node:crypto';
import { type FileHandle, open } from 'node:fs/promises';

export type JsonlSessionLockLease = {
    readonly sessionId: string;
    readonly ownerId: string;
    readonly pid?: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly heartbeatAt: string;
};

export type JsonlSessionLockRecovery = {
    readonly reason: 'stale' | 'stale_corrupt';
    readonly recoveredAt: string;
    readonly previousLock?: JsonlSessionLockMetadata;
};

export type AcquiredJsonlSessionLock = {
    readonly lockHandle: FileHandle;
    readonly lockLease: JsonlSessionLockLease;
    readonly lockRecovery?: JsonlSessionLockRecovery;
};

export type AcquireJsonlSessionLockOptions = {
    readonly sessionId: string;
    readonly lockPath: string;
    readonly now: () => string;
    readonly ownerId?: string;
    readonly pid?: number;
    readonly staleAfterMs?: number;
    readonly beforeExistingLockRead?: () => Promise<void>;
};

export async function acquireJsonlSessionLock(
    input: AcquireJsonlSessionLockOptions,
): Promise<AcquiredJsonlSessionLock> {
    let recovery: JsonlSessionLockRecovery | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const lease = createLockLease(input);
        let lockHandle: FileHandle;
        try {
            lockHandle = await open(input.lockPath, 'wx', 0o600);
        } catch (error: unknown) {
            if (getErrorCode(error) !== 'EEXIST') {
                throw lockFailed(input, 'could not acquire its lock', error);
            }
            const checkedAt = input.now();
            await input.beforeExistingLockRead?.();
            const readResult = await readExistingJsonlSessionLock(input);
            if (readResult.kind === 'missing') {
                recovery = { reason: 'stale', recoveredAt: checkedAt };
                continue;
            }
            if (readResult.kind === 'invalid') {
                if (isStaleInvalidLock(readResult, checkedAt, input.staleAfterMs)) {
                    recovery = { reason: 'stale_corrupt', recoveredAt: checkedAt };
                    await removeStaleInvalidLock(input, readResult);
                    continue;
                }
                throw lockExists(input, readResult.cause);
            }
            if (!isStaleLock(readResult.metadata, checkedAt, input.staleAfterMs)) {
                throw lockExists(input, error);
            }
            recovery = {
                reason: 'stale',
                recoveredAt: checkedAt,
                previousLock: readResult.metadata,
            };
            await removeStaleLock(input, readResult);
            continue;
        }
        try {
            await writeLockLease(lockHandle, lease);
            return recovery === undefined
                ? { lockHandle, lockLease: lease }
                : { lockHandle, lockLease: lease, lockRecovery: recovery };
        } catch (error: unknown) {
            await releaseJsonlSessionLock(lockHandle, input.lockPath);
            throw lockFailed(input, 'could not write its lock metadata', error);
        }
    }
    throw lockFailed(input, 'could not replace a stale lock after retrying');
}

export async function heartbeatJsonlSessionLock(input: {
    readonly lockHandle: FileHandle;
    readonly lockPath: string;
    readonly lockLease: JsonlSessionLockLease;
    readonly now: () => string;
}): Promise<AcquiredJsonlSessionLock> {
    await ensureLockPathStillOwned(input.lockHandle, input.lockPath, input.lockLease.sessionId);
    const heartbeatAt = input.now();
    const nextLease = { ...input.lockLease, updatedAt: heartbeatAt, heartbeatAt };
    try {
        await writeLockLease(input.lockHandle, nextLease);
    } catch (error: unknown) {
        throw lockFailed(
            { sessionId: nextLease.sessionId, lockPath: input.lockPath },
            'could not refresh its lock lease',
            error,
        );
    }
    await ensureLockPathStillOwned(input.lockHandle, input.lockPath, nextLease.sessionId);
    return { lockHandle: input.lockHandle, lockLease: nextLease };
}

export async function releaseJsonlSessionLock(lockHandle: FileHandle, lockPath: string): Promise<void> {
    const lockIdentity = await readJsonlSessionLockIdentity(lockHandle);
    try {
        await lockHandle.close();
    } finally {
        await removeJsonlSessionLockPathIfOwned(lockPath, lockIdentity);
    }
}

async function ensureLockPathStillOwned(lockHandle: FileHandle, lockPath: string, sessionId: string): Promise<void> {
    const lockIdentity = await readJsonlSessionLockIdentity(lockHandle);
    if (!(await jsonlSessionLockPathMatches(lockPath, lockIdentity))) {
        throw lockExists({ sessionId, lockPath });
    }
}

async function removeStaleLock(
    input: Pick<AcquireJsonlSessionLockOptions, 'sessionId' | 'lockPath'>,
    expected: Extract<JsonlSessionLockReadResult, { readonly kind: 'metadata' }>,
): Promise<boolean> {
    const latest = await readExistingJsonlSessionLock(input);
    if (latest.kind === 'missing') {
        return false;
    }
    if (latest.kind !== 'metadata' || !sameLockMetadata(latest.metadata, expected.metadata)) {
        throw lockExists(input, latest.kind === 'invalid' ? latest.cause : undefined);
    }
    if (latest.identity.dev !== expected.identity.dev || latest.identity.ino !== expected.identity.ino) {
        return false;
    }
    return removeClaimedJsonlSessionLockPath(input.lockPath, latest.identity);
}

function createLockLease(input: AcquireJsonlSessionLockOptions): JsonlSessionLockLease {
    const timestamp = input.now();
    const base = {
        sessionId: input.sessionId,
        ownerId: input.ownerId ?? randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
        heartbeatAt: timestamp,
    };
    const pid = input.pid ?? process.pid;
    return Number.isInteger(pid) ? { ...base, pid } : base;
}

async function writeLockLease(lockHandle: FileHandle, lease: JsonlSessionLockLease): Promise<void> {
    await lockHandle.truncate(0);
    await lockHandle.write(`${JSON.stringify(lease)}\n`, 0, 'utf8');
    await lockHandle.sync();
}

async function removeStaleInvalidLock(
    input: Pick<AcquireJsonlSessionLockOptions, 'lockPath'>,
    expected: Extract<JsonlSessionLockReadResult, { readonly kind: 'invalid' }>,
): Promise<boolean> {
    return expected.identity === undefined
        ? false
        : removeClaimedJsonlSessionLockPath(input.lockPath, expected.identity);
}

function lockExists(input: Pick<AcquireJsonlSessionLockOptions, 'sessionId' | 'lockPath'>, cause?: unknown) {
    return jsonlStoreError({
        code: 'lock_exists',
        message: `JSONL session log ${input.sessionId} is already locked`,
        sessionId: input.sessionId,
        path: input.lockPath,
        cause,
    });
}

function lockFailed(
    input: Pick<AcquireJsonlSessionLockOptions, 'sessionId' | 'lockPath'>,
    reason: string,
    cause?: unknown,
) {
    return jsonlStoreError({
        code: 'lock_failed',
        message: `JSONL session log ${input.sessionId} ${reason}`,
        sessionId: input.sessionId,
        path: input.lockPath,
        cause,
    });
}

function getErrorCode(error: unknown): string | undefined {
    if (!(error instanceof Error) || !('code' in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}

export { DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS };
