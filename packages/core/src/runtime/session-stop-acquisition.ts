import { SessionStopReceiptSchema } from '@mission-control/protocol';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db.js';
import type { LocalSessionEventStore } from '../memory/local-session-store.js';
import { SessionControlFencedError, type SessionControlHost } from './session-control-host.js';
import {
    completeSessionControlOperation,
    createSessionControlOperation,
    failSessionControlOperation,
    startSessionControlOperationDeadline,
    timeoutSessionControlOperation,
} from './session-control-operation.js';
import { readSessionTerminalStatus } from './session-stop-mutation.js';
import {
    EMPTY_STOP_AFFECTED,
    failedStopReceipt,
    stopReceipt,
    validateExactStopInput,
} from './session-stop-service-support.js';
import type { ExactSessionStopAcquisition, ExactSessionStopInput, SessionStopReceipt } from './session-stop-types.js';

export class SessionStopAcquisitionController {
    private readonly runtime: LocalLibsqlWriteTarget;
    private readonly host: SessionControlHost;
    private readonly openStore: (sessionId: string) => Promise<LocalSessionEventStore>;
    private readonly now: () => Date;
    private readonly monotonicNow: () => number;
    private readonly schedule: ((callback: () => void | Promise<void>, delayMs: number) => unknown) | undefined;
    private readonly cancel: ((timer: unknown) => void) | undefined;

    constructor(input: {
        readonly runtime: LocalLibsqlWriteTarget;
        readonly host: SessionControlHost;
        readonly openStore: (sessionId: string) => Promise<LocalSessionEventStore>;
        readonly now: () => Date;
        readonly monotonicNow: () => number;
        readonly schedule?: (callback: () => void | Promise<void>, delayMs: number) => unknown;
        readonly cancel?: (timer: unknown) => void;
    }) {
        this.runtime = input.runtime;
        this.host = input.host;
        this.openStore = input.openStore;
        this.now = input.now;
        this.monotonicNow = input.monotonicNow;
        this.schedule = input.schedule;
        this.cancel = input.cancel;
    }

    async acquire(input: ExactSessionStopInput, onTerminalRelease?: () => void): Promise<ExactSessionStopAcquisition> {
        validateExactStopInput(input);
        if (this.host.classify(input.sessionId).kind === 'stopping') {
            throw new SessionControlFencedError('session is already stopping');
        }
        const snapshot = await this.host.stopSnapshot(input.sessionId, {
            ownerId: input.ownerId,
            epoch: input.ownerEpoch,
        });
        try {
            const terminal = await readSessionTerminalStatus(this.runtime.client, input.sessionId);
            const store = await this.openStore(input.sessionId);
            let existingEvents: Awaited<ReturnType<LocalSessionEventStore['getEvents']>>;
            try {
                existingEvents = await store.getEvents(input.sessionId);
            } finally {
                await store.close();
            }
            const now = this.now();
            const deadlineWallMs = now.getTime() + input.timeoutMs;
            const deadlineMonotonicMs = this.monotonicNow() + input.timeoutMs;
            const handles = snapshot.attachments.flatMap((attachment) => attachment.handles);
            await createSessionControlOperation({
                runtime: this.runtime,
                lease: snapshot.lease,
                operationId: input.operationId,
                barrierKind: 'all_mutations',
                deadlineWallMs,
                capturedHandleIds: handles.map((handle) => handle.handleId),
                nowWallMs: now.getTime(),
            });
            const immediate = immediateReceipt(input, terminal);
            if (immediate !== undefined)
                await this.completeImmediate(snapshot.lease, input.operationId, immediate, now);
            const acquisition: ExactSessionStopAcquisition = {
                input,
                lease: snapshot.lease,
                snapshot,
                handles,
                existingEvents,
                deadlineMonotonicMs,
                timer: undefined,
                receipt: immediate,
                stopPromise: undefined,
                timeoutPromise: undefined,
                affected: EMPTY_STOP_AFFECTED,
                executionStarted: false,
                released: false,
                releasePromise: undefined,
                onTerminalRelease,
            };
            acquisition.timer = startSessionControlOperationDeadline({
                deadlineWallMs,
                nowWallMs: now.getTime(),
                monotonicNow: this.monotonicNow,
                ...(this.schedule !== undefined ? { schedule: this.schedule } : {}),
                ...(this.cancel !== undefined ? { cancel: this.cancel } : {}),
                onDeadline: async () => {
                    await this.timeout(acquisition);
                },
            });
            return acquisition;
        } catch (error: unknown) {
            await snapshot.release();
            await this.host
                .cancelStop(input.sessionId, { ownerId: input.ownerId, epoch: input.ownerEpoch })
                .catch(() => undefined);
            throw error;
        }
    }

    async release(acquisition: ExactSessionStopAcquisition): Promise<void> {
        if (acquisition.released) return;
        if (acquisition.stopPromise !== undefined && acquisition.receipt === undefined) {
            await acquisition.stopPromise.catch(() => undefined);
        }
        if (acquisition.receipt === undefined && acquisition.stopPromise === undefined) {
            await this.cancelUnstarted(acquisition);
            return;
        }
        acquisition.released = true;
        acquisition.timer?.stop();
        await acquisition.snapshot.release();
        await this.host.release(acquisition.input.sessionId);
    }

    timeout(acquisition: ExactSessionStopAcquisition): Promise<SessionStopReceipt> {
        if (acquisition.timeoutPromise !== undefined) return acquisition.timeoutPromise;
        const timeout = this.commitTimeout(acquisition);
        acquisition.timeoutPromise = timeout;
        return timeout;
    }

    async fail(acquisition: ExactSessionStopAcquisition, receipt: SessionStopReceipt): Promise<SessionStopReceipt> {
        if (acquisition.receipt !== undefined) return acquisition.receipt;
        const nowWallMs = Date.now();
        const result = await failSessionControlOperation({
            runtime: this.runtime,
            lease: acquisition.lease,
            operationId: acquisition.input.operationId,
            receipt,
            barrierReleasedAt: nowWallMs,
            nowWallMs,
        });
        const failed = SessionStopReceiptSchema.parse(result.receipt);
        acquisition.receipt = failed;
        await this.releaseTerminal(acquisition, true);
        return failed;
    }

    private async completeImmediate(
        lease: ExactSessionStopAcquisition['lease'],
        operationId: string,
        receipt: SessionStopReceipt,
        now: Date,
    ): Promise<void> {
        await completeSessionControlOperation({
            runtime: this.runtime,
            lease,
            operationId,
            status: receipt.outcome === 'failed' ? 'failed' : 'completed',
            receipt,
            barrierReleasedAt: now.getTime(),
            nowWallMs: now.getTime(),
        });
    }

    private async cancelUnstarted(acquisition: ExactSessionStopAcquisition): Promise<void> {
        const releasedAt = Date.now();
        await completeSessionControlOperation({
            runtime: this.runtime,
            lease: acquisition.lease,
            operationId: acquisition.input.operationId,
            status: 'completed',
            receipt: {
                outcome: 'barrier_released',
                requestId: acquisition.input.requestId,
                operationId: acquisition.input.operationId,
            },
            barrierReleasedAt: releasedAt,
            nowWallMs: releasedAt,
        });
        acquisition.released = true;
        acquisition.timer?.stop();
        await acquisition.snapshot.release();
        await this.host.cancelStop(acquisition.input.sessionId, acquisition.lease);
        await this.host.release(acquisition.input.sessionId);
    }

    private async commitTimeout(acquisition: ExactSessionStopAcquisition): Promise<SessionStopReceipt> {
        if (acquisition.receipt !== undefined) {
            await this.release(acquisition);
            return acquisition.receipt;
        }
        const failed = failedStopReceipt(acquisition.input, 'stop_timeout', acquisition.affected);
        const nowWallMs = Date.now();
        const result = await timeoutSessionControlOperation({
            runtime: this.runtime,
            lease: acquisition.lease,
            operationId: acquisition.input.operationId,
            receipt: failed,
            barrierReleasedAt: nowWallMs,
            nowWallMs,
            releaseBarrier: () => undefined,
        });
        const receipt = SessionStopReceiptSchema.parse(result.receipt);
        acquisition.receipt = receipt;
        await this.releaseTerminal(acquisition, acquisition.executionStarted);
        return receipt;
    }

    private async releaseTerminal(acquisition: ExactSessionStopAcquisition, fence: boolean): Promise<void> {
        if (acquisition.releasePromise !== undefined) return acquisition.releasePromise;
        const release = (async () => {
            acquisition.timer?.stop();
            await acquisition.snapshot.release();
            if (fence) {
                await this.host.fenceSession(acquisition.input.sessionId);
            } else {
                await this.host.cancelStop(acquisition.input.sessionId, acquisition.lease);
                await this.host.release(acquisition.input.sessionId);
            }
            acquisition.released = true;
            acquisition.onTerminalRelease?.();
        })();
        acquisition.releasePromise = release;
        return release;
    }
}

function immediateReceipt(
    input: ExactSessionStopInput,
    terminal: 'active' | 'missing' | 'terminal',
): SessionStopReceipt | undefined {
    if (terminal === 'missing') return failedStopReceipt(input, 'session_not_found');
    if (terminal === 'terminal') return stopReceipt(input, 'already_terminal', EMPTY_STOP_AFFECTED);
    return undefined;
}
