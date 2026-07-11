import type { SessionStopBarrierKind } from '@mission-control/protocol';

export const SESSION_CONTROL_SETTLED_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const SESSION_CONTROL_DEAD_LEASE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const SESSION_CONTROL_LATE_SETTLEMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_CONTROL_GC_INTERVAL_MS = 60 * 60 * 1_000;

export type SessionControlOperationStatus = 'active' | 'completed' | 'failed' | 'timed_out';

export type SessionControlOperation = {
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly operationId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly barrierKind: SessionStopBarrierKind;
    readonly status: SessionControlOperationStatus;
    readonly deadlineWallMs: number;
    readonly receipt: unknown;
    readonly capturedHandleIds: readonly string[];
    readonly settledHandleIds: readonly string[];
    readonly barrierReleasedAt: number | null;
    readonly createdAt: number;
    readonly terminalAt: number | null;
    readonly retentionUntil: number;
};

const safeLateSettlementStatuses = new Set([
    'active',
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'interrupted',
]);
const safeLateSettlementErrorCodes = new Set([
    'provider_auth_failed',
    'provider_rate_limited',
    'provider_timeout',
    'provider_aborted',
    'operator_aborted',
    'provider_context_overflow',
    'tool_failed',
    'schema_invalid',
    'unknown',
    'stop_timeout',
    'command_failed',
    'command_timed_out',
]);

export type SessionControlLateSettlementMetadata = {
    readonly status?: string;
    readonly errorCode?: string;
    readonly signalAborted?: boolean;
    readonly elapsedMs?: number;
};

export function redactLateSettlementMetadata(
    metadata: Readonly<Record<string, unknown>>,
): SessionControlLateSettlementMetadata {
    const { status, errorCode, signalAborted, elapsedMs } = metadata;
    const redacted: {
        status?: string;
        errorCode?: string;
        signalAborted?: boolean;
        elapsedMs?: number;
    } = {};
    if (typeof status === 'string' && safeLateSettlementStatuses.has(status)) redacted.status = status;
    if (typeof errorCode === 'string' && safeLateSettlementErrorCodes.has(errorCode)) redacted.errorCode = errorCode;
    if (typeof signalAborted === 'boolean') redacted.signalAborted = signalAborted;
    if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
        redacted.elapsedMs = elapsedMs;
    }
    return redacted;
}

export function assertOperationWallTime(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('session control operation wall time must be a nonnegative safe integer');
    }
}
