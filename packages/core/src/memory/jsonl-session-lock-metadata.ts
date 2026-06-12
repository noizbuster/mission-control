import type { JsonlSessionLockIdentity } from './jsonl-session-lock-identity.js';

export const DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS = 30_000;

export type JsonlSessionLockMetadata = {
    readonly sessionId: string;
    readonly ownerId?: string;
    readonly pid?: number;
    readonly createdAt: string;
    readonly updatedAt?: string;
    readonly heartbeatAt?: string;
};

export type JsonlSessionLockReadResult =
    | { readonly kind: 'missing' }
    | {
          readonly kind: 'invalid';
          readonly cause: unknown;
          readonly identity?: JsonlSessionLockIdentity;
          readonly modifiedAtMs?: number;
      }
    | {
          readonly kind: 'metadata';
          readonly metadata: JsonlSessionLockMetadata;
          readonly identity: JsonlSessionLockIdentity;
          readonly modifiedAtMs: number;
      };

type LockMetadataCandidate = Partial<
    Record<'sessionId' | 'ownerId' | 'pid' | 'createdAt' | 'updatedAt' | 'heartbeatAt', unknown>
>;

export function lockMetadataFromUnknown(value: unknown): JsonlSessionLockMetadata | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const sessionId = value.sessionId;
    const createdAt = value.createdAt;
    if (typeof sessionId !== 'string' || typeof createdAt !== 'string') {
        return undefined;
    }
    const ownerId = stringOrUndefined(value.ownerId);
    const pid = typeof value.pid === 'number' && Number.isInteger(value.pid) ? value.pid : undefined;
    const updatedAt = stringOrUndefined(value.updatedAt);
    const heartbeatAt = stringOrUndefined(value.heartbeatAt);
    return {
        sessionId,
        createdAt,
        ...(ownerId !== undefined ? { ownerId } : {}),
        ...(pid !== undefined ? { pid } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
    };
}

export function isStaleLock(
    metadata: JsonlSessionLockMetadata,
    checkedAt: string,
    staleAfterMs = DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS,
): boolean {
    return isExpiredAt(metadata.heartbeatAt ?? metadata.updatedAt ?? metadata.createdAt, checkedAt, staleAfterMs);
}

export function isStaleInvalidLock(
    readResult: Extract<JsonlSessionLockReadResult, { readonly kind: 'invalid' }>,
    checkedAt: string,
    staleAfterMs = DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS,
): boolean {
    if (readResult.modifiedAtMs === undefined) {
        return false;
    }
    return isExpiredAt(new Date(readResult.modifiedAtMs).toISOString(), checkedAt, staleAfterMs);
}

export function sameLockMetadata(left: JsonlSessionLockMetadata, right: JsonlSessionLockMetadata): boolean {
    return (
        left.sessionId === right.sessionId &&
        left.ownerId === right.ownerId &&
        left.pid === right.pid &&
        left.createdAt === right.createdAt &&
        left.updatedAt === right.updatedAt &&
        left.heartbeatAt === right.heartbeatAt
    );
}

function isExpiredAt(previous: string, checkedAt: string, staleAfterMs: number): boolean {
    const previousMs = Date.parse(previous);
    const checkedAtMs = Date.parse(checkedAt);
    return Number.isFinite(previousMs) && Number.isFinite(checkedAtMs)
        ? checkedAtMs - previousMs >= staleAfterMs
        : false;
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is LockMetadataCandidate {
    return typeof value === 'object' && value !== null;
}
