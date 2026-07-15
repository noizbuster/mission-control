import { SessionStopReceiptSchema } from '@mission-control/protocol';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import type { LocalSessionEventStore } from '../memory/local-session-store';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import { releaseMissionRunControlAttachment } from './mission-run/mission-run-service';
import { SessionControlFencedError, type SessionControlHost } from './session-control-host';
import { runWithSessionControlLeaseFence, SessionControlLeaseError } from './session-control-lease';
import {
    completeSessionControlOperationWithClient,
    failSessionControlOperationAfterFenceLoss,
} from './session-control-operation';
import { SessionStopAcquisitionController } from './session-stop-acquisition';
import { appendFencedSessionStopEvent } from './session-stop-event-writer';
import { applyStopMutation, readSessionStatus, refreshStoppedSession } from './session-stop-mutation';
import {
    abortCompletedEvent,
    appendStopCancellationEvents,
    failedStopReceipt,
    hasStopAffected,
    settleStopHandlesBeforeDeadline,
    stopReceipt,
} from './session-stop-service-support';
import type { ExactSessionStopAcquisition, ExactSessionStopInput, SessionStopReceipt } from './session-stop-types';

export type { ExactSessionStopAcquisition, ExactSessionStopInput, SessionStopReceipt } from './session-stop-types';

export class SessionStopService {
    private readonly runtime: LocalLibsqlWriteTarget;
    private readonly host: SessionControlHost;
    private readonly now: () => Date;
    private readonly monotonicNow: () => number;
    private readonly acquisitions: SessionStopAcquisitionController;
    private readonly observabilityRedactor: ObservabilityRedactor | undefined;

    constructor(input: {
        readonly runtime: LocalLibsqlWriteTarget;
        readonly host: SessionControlHost;
        readonly missionRoot: string;
        readonly openStore: (sessionId: string) => Promise<LocalSessionEventStore>;
        readonly now?: () => Date;
        readonly monotonicNow?: () => number;
        readonly deadlineSchedule?: (callback: () => void | Promise<void>, delayMs: number) => unknown;
        readonly deadlineCancel?: (timer: unknown) => void;
        readonly observabilityRedactor?: ObservabilityRedactor;
    }) {
        this.runtime = input.runtime;
        this.host = input.host;
        this.now = input.now ?? (() => new Date());
        this.monotonicNow = input.monotonicNow ?? (() => performance.now());
        this.observabilityRedactor = input.observabilityRedactor;
        this.acquisitions = new SessionStopAcquisitionController({
            runtime: input.runtime,
            host: input.host,
            openStore: input.openStore,
            now: this.now,
            monotonicNow: this.monotonicNow,
            ...(input.deadlineSchedule !== undefined ? { schedule: input.deadlineSchedule } : {}),
            ...(input.deadlineCancel !== undefined ? { cancel: input.deadlineCancel } : {}),
        });
    }

    async stopExact(input: ExactSessionStopInput): Promise<SessionStopReceipt> {
        if (this.host.classify(input.sessionId).kind === 'stopping') {
            return failedStopReceipt(input, 'session_stopping');
        }
        let acquisition: ExactSessionStopAcquisition;
        try {
            acquisition = await this.acquireExact(input);
        } catch (error: unknown) {
            if (error instanceof SessionControlFencedError || error instanceof SessionControlLeaseError) {
                return failedStopReceipt(input, 'session_owned_elsewhere');
            }
            throw error;
        }
        try {
            return await this.stopAcquired(acquisition);
        } finally {
            await this.releaseAcquired(acquisition);
        }
    }

    async acquireExact(
        input: ExactSessionStopInput,
        onTerminalRelease?: () => void,
    ): Promise<ExactSessionStopAcquisition> {
        return this.acquisitions.acquire(input, onTerminalRelease);
    }

    stopAcquired(acquisition: ExactSessionStopAcquisition): Promise<SessionStopReceipt> {
        if (acquisition.receipt !== undefined) return Promise.resolve(acquisition.receipt);
        if (acquisition.stopPromise !== undefined) return acquisition.stopPromise;
        acquisition.executionStarted = true;
        const execution = this.executeAcquired(acquisition)
            .then((receipt) => {
                if (acquisition.receipt === undefined) acquisition.receipt = receipt;
                return acquisition.receipt;
            })
            .catch(() =>
                this.acquisitions.fail(
                    acquisition,
                    failedStopReceipt(acquisition.input, 'owner_unreachable', acquisition.affected),
                ),
            );
        acquisition.stopPromise = execution;
        return execution;
    }

    async releaseAcquired(acquisition: ExactSessionStopAcquisition): Promise<void> {
        await this.acquisitions.release(acquisition);
    }

    private async executeAcquired(acquisition: ExactSessionStopAcquisition): Promise<SessionStopReceipt> {
        const { input, lease, snapshot, handles, existingEvents, deadlineMonotonicMs } = acquisition;
        const timestamp = this.now().toISOString();
        try {
            const mutation = await runWithSessionControlLeaseFence({
                runtime: this.runtime,
                lease,
                nowWallMs: Date.now(),
                write: async (client) => {
                    const result = await applyStopMutation({
                        client,
                        sessionId: input.sessionId,
                        timestamp,
                        ...(this.observabilityRedactor !== undefined
                            ? { observabilityRedactor: this.observabilityRedactor }
                            : {}),
                    });
                    await appendStopCancellationEvents(
                        client,
                        input,
                        result,
                        existingEvents,
                        timestamp,
                        this.observabilityRedactor,
                    );
                    return result;
                },
            });
            await Promise.all(
                snapshot.attachments
                    .filter((attachment) => attachment.handles.length === 0)
                    .map((attachment) => this.host.detachEntity(input.sessionId, attachment.kind, attachment.entityId)),
            );
            acquisition.affected = mutation.affected;
            await Promise.all(mutation.missionRunIds.map(releaseMissionRunControlAttachment));
            const settled = await settleStopHandlesBeforeDeadline({
                runtime: this.runtime,
                lease,
                operationId: input.operationId,
                sessionId: input.sessionId,
                requestId: input.requestId,
                timestamp,
                deadlineMonotonicMs,
                monotonicNow: this.monotonicNow,
                handles,
            });
            if (!settled) {
                return this.acquisitions.timeout(acquisition);
            }
            await Promise.all(
                snapshot.attachments.map((attachment) =>
                    this.host.detachEntity(input.sessionId, attachment.kind, attachment.entityId),
                ),
            );
            await runWithSessionControlLeaseFence({
                runtime: this.runtime,
                lease,
                nowWallMs: Date.now(),
                write: (client) => refreshStoppedSession(client, input.sessionId, new Date().toISOString()),
            });
            if ((await readSessionStatus(this.runtime.client, input.sessionId)) !== 'idle') {
                return this.acquisitions.timeout(acquisition);
            }
            const outcome = hasStopAffected(mutation.affected) ? 'interrupted' : 'already_idle';
            const completed = stopReceipt(input, outcome, mutation.affected);
            const completedAt = Date.now();
            await runWithSessionControlLeaseFence({
                runtime: this.runtime,
                lease,
                nowWallMs: completedAt,
                write: async (client) => {
                    await appendFencedSessionStopEvent({
                        client,
                        sessionId: input.sessionId,
                        event: abortCompletedEvent(input, mutation.affected, new Date(completedAt).toISOString()),
                        ...(this.observabilityRedactor !== undefined
                            ? { observabilityRedactor: this.observabilityRedactor }
                            : {}),
                    });
                    await completeSessionControlOperationWithClient(client, {
                        lease,
                        operationId: input.operationId,
                        status: 'completed',
                        receipt: completed,
                        barrierReleasedAt: completedAt,
                        nowWallMs: completedAt,
                    });
                },
            });
            return completed;
        } catch (error: unknown) {
            if (error instanceof SessionControlFencedError || error instanceof SessionControlLeaseError) {
                return this.failAfterFenceLoss(acquisition, failedStopReceipt(input, 'session_owned_elsewhere'));
            }
            throw error;
        }
    }

    private async failAfterFenceLoss(
        acquisition: ExactSessionStopAcquisition,
        receipt: SessionStopReceipt,
    ): Promise<SessionStopReceipt> {
        if (acquisition.receipt !== undefined) return acquisition.receipt;
        const nowWallMs = Date.now();
        const result = await failSessionControlOperationAfterFenceLoss({
            runtime: this.runtime,
            lease: acquisition.lease,
            operationId: acquisition.input.operationId,
            receipt,
            barrierReleasedAt: nowWallMs,
            nowWallMs,
        });
        const failed = SessionStopReceiptSchema.parse(result.receipt);
        acquisition.receipt = failed;
        return failed;
    }
}
