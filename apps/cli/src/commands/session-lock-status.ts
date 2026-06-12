import { readFile } from 'node:fs/promises';

const DEFAULT_LOCK_STALE_AFTER_MS = 30_000;
const RFC3339_UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type CliSessionLockState = 'none' | 'live' | 'stale' | 'corrupt';

type SessionLockMetadata = {
    readonly sessionId: string;
    readonly ownerId?: string;
    readonly pid?: number;
    readonly createdAt: string;
    readonly updatedAt?: string;
    readonly heartbeatAt?: string;
};

type LockReadResult =
    | { readonly kind: 'missing' }
    | { readonly kind: 'corrupt' }
    | { readonly kind: 'metadata'; readonly metadata: SessionLockMetadata };

type LockMetadataParseResult =
    | { readonly kind: 'invalid' }
    | { readonly kind: 'corrupt' }
    | { readonly kind: 'metadata'; readonly metadata: SessionLockMetadata };

type LockMetadataCandidate = Partial<
    Record<'sessionId' | 'ownerId' | 'pid' | 'createdAt' | 'updatedAt' | 'heartbeatAt', unknown>
>;

export async function readSessionLockState(input: {
    readonly sessionId: string;
    readonly lockPath: string;
    readonly checkedAt?: string | undefined;
}): Promise<CliSessionLockState> {
    const result = await readLock(input);
    const checkedAt = input.checkedAt ?? new Date().toISOString();
    switch (result.kind) {
        case 'missing':
            return 'none';
        case 'metadata':
            return isStaleLock(result.metadata, checkedAt) ? 'stale' : 'live';
        case 'corrupt':
            return 'corrupt';
        default:
            return assertNever(result);
    }
}

async function readLock(input: { readonly sessionId: string; readonly lockPath: string }): Promise<LockReadResult> {
    try {
        const contents = await readFile(input.lockPath, 'utf8');
        const parsed = lockMetadataFromUnknown(JSON.parse(contents));
        switch (parsed.kind) {
            case 'metadata':
                return parsed.metadata.sessionId === input.sessionId
                    ? { kind: 'metadata', metadata: parsed.metadata }
                    : { kind: 'corrupt' };
            case 'corrupt':
                return { kind: 'corrupt' };
            case 'invalid':
                return { kind: 'corrupt' };
            default:
                return assertNever(parsed);
        }
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return { kind: 'missing' };
        }
        if (error instanceof Error) {
            return { kind: 'corrupt' };
        }
        throw error;
    }
}

function lockMetadataFromUnknown(value: unknown): LockMetadataParseResult {
    if (!isRecord(value)) {
        return { kind: 'invalid' };
    }
    const sessionId = value.sessionId;
    const createdAt = value.createdAt;
    if (typeof sessionId !== 'string' || typeof createdAt !== 'string') {
        return { kind: 'invalid' };
    }
    if (!isRfc3339UtcMillis(createdAt)) {
        return { kind: 'corrupt' };
    }
    const ownerId = stringOrUndefined(value.ownerId);
    const pid = typeof value.pid === 'number' && Number.isInteger(value.pid) ? value.pid : undefined;
    const updatedAt = timestampOrUndefined(value.updatedAt);
    const heartbeatAt = timestampOrUndefined(value.heartbeatAt);
    if (updatedAt === null || heartbeatAt === null) {
        return { kind: 'corrupt' };
    }
    return {
        kind: 'metadata',
        metadata: {
            sessionId,
            createdAt,
            ...(ownerId !== undefined ? { ownerId } : {}),
            ...(pid !== undefined ? { pid } : {}),
            ...(updatedAt !== undefined ? { updatedAt } : {}),
            ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
        },
    };
}

function isStaleLock(metadata: SessionLockMetadata, checkedAt: string): boolean {
    return isExpiredAt(metadata.heartbeatAt ?? metadata.updatedAt ?? metadata.createdAt, checkedAt);
}

function isExpiredAt(previous: string, checkedAt: string): boolean {
    const previousMs = Date.parse(previous);
    const checkedAtMs = Date.parse(checkedAt);
    return Number.isFinite(previousMs) && Number.isFinite(checkedAtMs)
        ? checkedAtMs - previousMs >= DEFAULT_LOCK_STALE_AFTER_MS
        : false;
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestampOrUndefined(value: unknown): string | undefined | null {
    if (value === undefined) {
        return undefined;
    }
    return typeof value === 'string' && isRfc3339UtcMillis(value) ? value : null;
}

function isRfc3339UtcMillis(value: string): boolean {
    return RFC3339_UTC_MILLIS_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is LockMetadataCandidate {
    return typeof value === 'object' && value !== null;
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}

function assertNever(value: never): never {
    throw new TypeError(`Unhandled session lock status variant: ${JSON.stringify(value)}`);
}
