import type { SessionAbortAffectedCounts, SessionStopReceiptContract } from '@mission-control/protocol';
import type { LocalSessionEventStore } from '../memory/local-session-store';
import type { SessionControlAttachedHandle, SessionControlHost } from './session-control-host';
import type { SessionControlOperationTimer } from './session-control-operation';

export type ExactSessionStopInput = {
    readonly sessionId: string;
    readonly requestId: string;
    readonly operationId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly timeoutMs: number;
};

export type SessionStopReceipt = SessionStopReceiptContract;

export type ExactSessionStopAcquisition = {
    readonly input: ExactSessionStopInput;
    readonly lease: Awaited<ReturnType<SessionControlHost['stopSnapshot']>>['lease'];
    readonly snapshot: Awaited<ReturnType<SessionControlHost['stopSnapshot']>>;
    readonly handles: readonly SessionControlAttachedHandle[];
    readonly existingEvents: Awaited<ReturnType<LocalSessionEventStore['getEvents']>>;
    readonly deadlineMonotonicMs: number;
    timer: SessionControlOperationTimer | undefined;
    receipt: SessionStopReceipt | undefined;
    stopPromise: Promise<SessionStopReceipt> | undefined;
    timeoutPromise: Promise<SessionStopReceipt> | undefined;
    affected: SessionAbortAffectedCounts;
    executionStarted: boolean;
    released: boolean;
    releasePromise: Promise<void> | undefined;
    readonly onTerminalRelease: (() => void) | undefined;
};
