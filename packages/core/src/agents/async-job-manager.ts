// allow: SIZE_OK -- HEAD 407 -> current 576 pure LOC; one bounded async-job lifecycle and persistence state machine.
/**
 * AsyncJobManager - bounds concurrent background child-agent execution via a
 * maxConcurrency semaphore. Jobs beyond the limit are queued and start when a
 * running job finishes. Cancellation is cooperative: each job owns an
 * AbortController whose signal is forwarded to the execute function, so it can
 * shut down promptly when {@link cancelJob} is called or the caller-provided
 * signal aborts.
 *
 * In-memory coordination remains authoritative. Persistence is opt-in through
 * a mirror observer that records handle snapshots.
 */

import type { Client } from '@libsql/client';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation';
import type { SessionControlAttachment, SessionControlHost } from '../runtime/session-control-host';
import { LifecycleCleanupError } from './lifecycle-cleanup-error';
import { randomBytes } from 'node:crypto';

export interface BackgroundJobHandle {
    readonly jobId: string;
    readonly sessionId: string;
    readonly parentSessionId?: string;
    readonly agentId?: string;
    readonly blocking?: boolean;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    result?: { status: 'completed' | 'failed'; output: string };
    error?: string;
    readonly startedAt: string;
    completedAt?: string;
    cancellationReason?: string;
    readonly controlEpoch?: SessionControlEpoch;
}

/**
 * Work function invoked when a job gets a concurrency slot. The signal is
 * aborted on cancellation so the function can cooperatively release resources.
 */
export type JobExecuteFn = (
    signal: AbortSignal,
    controlEpoch?: SessionControlEpoch,
) => Promise<{ status: 'completed' | 'failed'; output: string }>;

export interface StartJobInput {
    readonly sessionId: string;
    readonly parentSessionId?: string;
    readonly agentId?: string;
    readonly blocking?: boolean;
    readonly execute: JobExecuteFn;
    readonly onTerminatedBeforeStart?: () => void;
    /** When this signal aborts the job is cancelled automatically. */
    readonly signal?: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
}

export interface AsyncJobPersistenceMirror {
    readonly recordJob: (handle: BackgroundJobHandle, client?: Client) => void | Promise<void>;
}

export interface AsyncJobManagerOptions {
    readonly mirror?: AsyncJobPersistenceMirror;
    readonly sessionControlHost?: SessionControlHost;
    /** Maximum number of terminal job entries retained in memory for `listJobs` / `awaitJob` queries. Older terminal entries are evicted; full history lives in the SQL mirror. Defaults to 32. */
    readonly maxTerminalEntries?: number;
}

export class QuarantinedJobSettlementError extends Error {
    readonly jobId: string;

    constructor(jobId: string) {
        super(`job settlement quarantined: ${jobId}`);
        this.name = 'QuarantinedJobSettlementError';
        this.jobId = jobId;
    }
}

export class AsyncJobCleanupError extends LifecycleCleanupError {
    constructor(primaryError: unknown, suppressedError: unknown) {
        super({
            name: 'AsyncJobCleanupError',
            message: 'background job failed and cleanup also failed',
            primaryError,
            suppressedError,
        });
    }
}

interface JobEntry {
    readonly handle: BackgroundJobHandle;
    readonly execute: JobExecuteFn;
    readonly onTerminatedBeforeStart: (() => void) | undefined;
    readonly controller: AbortController;
    readonly awaiters: Array<{
        readonly resolve: (handle: BackgroundJobHandle) => void;
        readonly reject: (error: Error) => void;
    }>;
    cancellationPending: boolean;
    cleanupPending: boolean;
    preparationPending: boolean;
    primaryFailure: { readonly error: unknown } | undefined;
    quarantineError?: QuarantinedJobSettlementError;
    terminatedBeforeStartNotified: boolean;
    terminalError: Error | undefined;
    controlAttachment: SessionControlAttachment | undefined;
    readonly signal?: AbortSignal;
    signalAbort: (() => void) | undefined;
}

const TERMINAL: ReadonlySet<BackgroundJobHandle['status']> = new Set(['completed', 'failed', 'cancelled']);

export class AsyncJobManager {
    private readonly jobs = new Map<string, JobEntry>();
    private readonly queue: string[] = [];
    private readonly pendingPreparations = new Set<Promise<void>>();
    private readonly pendingRuns = new Set<Promise<void>>();
    private readonly pendingSettlements = new Set<Promise<void>>();
    private active = 0;
    private readonly mirror: AsyncJobPersistenceMirror | undefined;
    private readonly sessionControlHost: SessionControlHost | undefined;
    /** FIFO of terminal job ids still retained in {@link jobs} for queryability. Evicted at {@link maxTerminalEntries}. */
    private readonly terminalOrder: string[] = [];
    private readonly maxTerminalEntries: number;

    constructor(
        private readonly maxConcurrency: number = 4,
        options: AsyncJobManagerOptions = {},
    ) {
        this.mirror = options.mirror;
        this.sessionControlHost = options.sessionControlHost;
        this.maxTerminalEntries = options.maxTerminalEntries ?? 32;
    }

    startJob(input: StartJobInput): BackgroundJobHandle {
        const jobId = `job_${Date.now()}_${randomBytes(4).toString('hex')}`;
        const controller = new AbortController();
        const handle: BackgroundJobHandle = {
            jobId,
            sessionId: input.sessionId,
            ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            ...(input.blocking !== undefined ? { blocking: input.blocking } : {}),
            status: 'queued',
            startedAt: new Date().toISOString(),
            ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
        };
        const entry: JobEntry = {
            handle,
            execute: input.execute,
            onTerminatedBeforeStart: input.onTerminatedBeforeStart,
            controller,
            awaiters: [],
            cancellationPending: false,
            cleanupPending: false,
            controlAttachment: undefined,
            preparationPending: this.sessionControlHost !== undefined,
            primaryFailure: undefined,
            signalAbort: undefined,
            terminatedBeforeStartNotified: false,
            terminalError: undefined,
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
        };
        this.jobs.set(jobId, entry);
        if (this.sessionControlHost !== undefined) this.armSignal(entry);
        if (this.sessionControlHost === undefined) this.activateEntry(entry);
        else this.trackPreparation(this.prepareControlledEntry(entry));
        return handle;
    }

    async awaitJob(jobId: string): Promise<BackgroundJobHandle> {
        const entry = this.jobs.get(jobId);
        if (entry === undefined) {
            throw new Error(`unknown job: ${jobId}`);
        }
        if (!entry.cleanupPending && !entry.preparationPending) {
            if (entry.terminalError !== undefined) throw entry.terminalError;
            if (entry.quarantineError !== undefined) throw entry.quarantineError;
            if (TERMINAL.has(entry.handle.status)) return entry.handle;
        }
        return new Promise<BackgroundJobHandle>((resolve, reject) => {
            entry.awaiters.push({ resolve, reject });
        });
    }

    cancelJob(jobId: string, reason = 'cancelled'): void {
        const entry = this.jobs.get(jobId);
        if (entry !== undefined) {
            this.applyCancellation(entry, reason);
        }
    }

    listJobs(): readonly BackgroundJobHandle[] {
        return Array.from(this.jobs.values(), (entry) => entry.handle);
    }

    getActiveCount(): number {
        return this.active;
    }

    async drainPreparations(): Promise<void> {
        await Promise.all(this.pendingPreparations);
    }

    async drain(): Promise<void> {
        for (;;) {
            const pending = [...this.pendingPreparations, ...this.pendingRuns, ...this.pendingSettlements];
            if (pending.length === 0) return;
            await Promise.all(pending);
        }
    }

    // --- internals ----------------------------------------------------------

    private tryStart(entry: JobEntry): void {
        if (this.active >= this.maxConcurrency) {
            this.queue.push(entry.handle.jobId);
            return;
        }
        this.runJob(entry);
    }

    private async prepareControlledEntry(entry: JobEntry): Promise<void> {
        try {
            const attachment = await this.sessionControlHost?.attachEntity({
                sessionId: entry.handle.parentSessionId ?? entry.handle.sessionId,
                kind: 'job',
                entityId: entry.handle.jobId,
                handles: [
                    {
                        kind: 'job',
                        handleId: `job:${entry.handle.jobId}`,
                        abort: async () => {
                            this.applyOperatorCancellation(entry);
                            await this.awaitJob(entry.handle.jobId);
                        },
                    },
                ],
            });
            if (attachment !== undefined) entry.controlAttachment = attachment;
            if (
                entry.cancellationPending ||
                TERMINAL.has(entry.handle.status) ||
                entry.quarantineError !== undefined ||
                entry.terminalError !== undefined
            ) {
                await this.detachControl(
                    entry,
                    entry.terminalError ?? entry.quarantineError ?? entry.primaryFailure?.error,
                );
                return;
            }
            this.activateEntry(entry);
        } catch (error: unknown) {
            const failedDuringActivation = entry.controlAttachment !== undefined;
            this.removeSignalAbort(entry);
            if (entry.cancellationPending) {
                this.recordCancellationPreparationFailure(entry, error);
                await this.detachControl(
                    entry,
                    entry.terminalError ?? entry.quarantineError ?? entry.primaryFailure?.error,
                );
                return;
            }
            entry.primaryFailure = { error };
            let terminalAccepted = false;
            if (failedDuringActivation) {
                applySettlementFailure(entry.handle, error);
                terminalAccepted = true;
            } else {
                try {
                    terminalAccepted = await this.settleJob(entry, { kind: 'error', error });
                } catch (settlementError: unknown) {
                    if (settlementError instanceof QuarantinedJobSettlementError) {
                        entry.quarantineError = settlementError;
                        const failure = new AsyncJobCleanupError(error, settlementError);
                        entry.primaryFailure = { error: failure };
                        entry.terminalError = failure;
                    } else {
                        const failure = new AsyncJobCleanupError(error, settlementError);
                        entry.primaryFailure = { error: failure };
                        entry.terminalError = failure;
                        applySettlementFailure(entry.handle, failure);
                    }
                }
            }
            await this.detachControl(entry, entry.terminalError ?? entry.primaryFailure.error);
            if (terminalAccepted) this.notifyTerminatedBeforeStart(entry);
        } finally {
            entry.preparationPending = false;
            if (
                !entry.cleanupPending &&
                (TERMINAL.has(entry.handle.status) ||
                    entry.quarantineError !== undefined ||
                    entry.terminalError !== undefined)
            ) {
                this.settleAwaiters(entry);
                this.reapTerminalJob(entry);
            }
        }
    }

    private trackPreparation(preparation: Promise<void>): void {
        this.pendingPreparations.add(preparation);
        void preparation.finally(() => this.pendingPreparations.delete(preparation)).catch(() => undefined);
    }

    private activateEntry(entry: JobEntry): void {
        this.recordJob(entry);
        if (entry.cancellationPending) return;
        this.armSignal(entry);
        if (entry.cancellationPending) return;
        this.tryStart(entry);
    }

    private runJob(entry: JobEntry): void {
        entry.handle.status = 'running';
        this.recordJob(entry);
        this.active++;
        entry.cleanupPending = true;

        let execution: ReturnType<JobExecuteFn>;
        try {
            execution = entry.execute(entry.controller.signal, entry.handle.controlEpoch);
        } catch (error: unknown) {
            execution = Promise.reject(error instanceof Error ? error : new TypeError(String(error)));
        }
        const run = execution
            .then(
                (result) => this.settleJob(entry, { kind: 'result', result }),
                (error: unknown) => {
                    entry.primaryFailure = { error };
                    if (error instanceof AggregateError) entry.terminalError = error;
                    return this.settleJob(entry, { kind: 'error', error });
                },
            )
            .catch((error: unknown) => {
                if (error instanceof QuarantinedJobSettlementError) {
                    entry.quarantineError = error;
                    if (entry.primaryFailure !== undefined) {
                        const failure = new AsyncJobCleanupError(entry.primaryFailure.error, error);
                        entry.primaryFailure = { error: failure };
                        entry.terminalError = failure;
                    }
                } else if (entry.primaryFailure === undefined) {
                    entry.primaryFailure = { error };
                    applySettlementFailure(entry.handle, error);
                } else {
                    const failure = new AsyncJobCleanupError(entry.primaryFailure.error, error);
                    entry.primaryFailure = { error: failure };
                    entry.terminalError = failure;
                    applySettlementFailure(entry.handle, failure);
                }
            })
            .then(() => this.finishRun(entry));
        this.trackRun(run);
    }

    private async finishRun(entry: JobEntry): Promise<void> {
        this.active--;
        this.removeSignalAbort(entry);
        await this.detachControl(entry, entry.terminalError ?? entry.quarantineError ?? entry.primaryFailure?.error);
        entry.cleanupPending = false;
        this.settleAwaiters(entry);
        this.reapTerminalJob(entry);
        this.drainQueue();
    }

    private async detachControl(entry: JobEntry, primaryError: unknown): Promise<void> {
        const attachment = entry.controlAttachment;
        entry.controlAttachment = undefined;
        try {
            await attachment?.detach();
        } catch (cleanupError: unknown) {
            const failure =
                primaryError === undefined
                    ? cleanupError instanceof Error
                        ? cleanupError
                        : new TypeError(String(cleanupError))
                    : new AsyncJobCleanupError(primaryError, cleanupError);
            entry.terminalError = failure;
            if (!TERMINAL.has(entry.handle.status)) applySettlementFailure(entry.handle, failure);
        }
    }

    private async settleJob(entry: JobEntry, outcome: JobExecutionOutcome): Promise<boolean> {
        const terminal = terminalJobHandle(entry, outcome);
        const fence = entry.handle.controlEpoch?.callbackFence;
        if (fence === undefined) {
            await this.mirror?.recordJob(terminal);
            applyTerminalJobHandle(entry.handle, terminal);
            return true;
        }
        const mirror = this.mirror;
        if (mirror === undefined) {
            throw new Error('controlled job persistence mirror is required');
        }
        const settlement = await fence.settle({
            handleKind: 'job',
            handleId: `job:${entry.handle.jobId}`,
            attemptedEventType: `job.${terminal.status}`,
            metadata: {
                status: terminal.status,
                ...(terminal.error !== undefined ? { errorCode: 'tool_failed' } : {}),
                signalAborted: entry.controller.signal.aborted,
            },
            write: (client) => Promise.resolve(mirror.recordJob(terminal, client)),
        });
        if (!settlement.accepted) throw new QuarantinedJobSettlementError(entry.handle.jobId);
        applyTerminalJobHandle(entry.handle, terminal);
        return true;
    }

    private applyCancellation(entry: JobEntry, reason: string): void {
        if (TERMINAL.has(entry.handle.status) || entry.cancellationPending) return;

        const wasQueued = entry.handle.status === 'queued';
        if (wasQueued) {
            this.removeFromQueue(entry.handle.jobId);
            this.settleQueuedCancellation(entry, reason);
            return;
        }
        entry.handle.cancellationReason = reason;
        entry.cancellationPending = true;
        entry.controller.abort();
        if (reason !== 'operator_aborted' && entry.handle.controlEpoch?.callbackFence === undefined) {
            entry.handle.status = 'cancelled';
            this.recordJob(entry);
        }
    }

    private applyOperatorCancellation(entry: JobEntry): void {
        if (TERMINAL.has(entry.handle.status) || entry.cancellationPending) return;
        if (entry.handle.status === 'queued') {
            this.removeFromQueue(entry.handle.jobId);
            this.settleQueuedCancellation(entry, 'operator_aborted');
            return;
        }
        entry.handle.cancellationReason = 'operator_aborted';
        entry.cancellationPending = true;
        entry.controller.abort();
    }

    private settleQueuedCancellation(entry: JobEntry, reason: string): void {
        entry.cancellationPending = true;
        entry.cleanupPending = true;
        this.removeSignalAbort(entry);
        const terminal: TerminalBackgroundJobHandle = {
            ...entry.handle,
            status: 'cancelled',
            completedAt: new Date().toISOString(),
            cancellationReason: reason,
        };
        const fence = entry.handle.controlEpoch?.callbackFence;
        if (fence === undefined) {
            applyTerminalJobHandle(entry.handle, terminal);
            this.recordJob(entry);
            this.notifyTerminatedBeforeStart(entry);
            this.trackSettlement(this.finishQueuedCancellation(entry));
            return;
        }
        const mirror = this.mirror;
        if (mirror === undefined) {
            const error = new Error('controlled job persistence mirror is required');
            entry.primaryFailure = { error };
            applySettlementFailure(entry.handle, error);
            this.trackSettlement(this.finishQueuedCancellation(entry));
            return;
        }
        const settlement = fence
            .settle({
                handleKind: 'job',
                handleId: `job:${entry.handle.jobId}`,
                attemptedEventType: 'job.cancelled',
                metadata: { status: 'cancelled', signalAborted: entry.controller.signal.aborted },
                write: (client) => Promise.resolve(mirror.recordJob(terminal, client)),
            })
            .then(
                (settlement) => {
                    if (settlement.accepted) {
                        applyTerminalJobHandle(entry.handle, terminal);
                        this.notifyTerminatedBeforeStart(entry);
                    } else {
                        const quarantineError = new QuarantinedJobSettlementError(entry.handle.jobId);
                        entry.quarantineError = quarantineError;
                        if (entry.primaryFailure !== undefined) {
                            const failure = new AsyncJobCleanupError(entry.primaryFailure.error, quarantineError);
                            entry.primaryFailure = { error: failure };
                            entry.terminalError = failure;
                        }
                    }
                },
                (error: unknown) => {
                    if (entry.primaryFailure === undefined) {
                        entry.primaryFailure = { error };
                        applySettlementFailure(entry.handle, error);
                    } else {
                        const failure = new AsyncJobCleanupError(entry.primaryFailure.error, error);
                        entry.primaryFailure = { error: failure };
                        entry.terminalError = failure;
                        applySettlementFailure(entry.handle, failure);
                    }
                },
            )
            .then(() => this.finishQueuedCancellation(entry));
        this.trackSettlement(settlement);
    }

    private async finishQueuedCancellation(entry: JobEntry): Promise<void> {
        await this.detachControl(entry, entry.quarantineError ?? entry.primaryFailure?.error);
        entry.cleanupPending = false;
        if (!entry.preparationPending) {
            this.settleAwaiters(entry);
            this.reapTerminalJob(entry);
        }
    }

    private settleAwaiters(entry: JobEntry): void {
        if (entry.awaiters.length === 0) return;
        const pending = entry.awaiters.splice(0);
        for (const awaiter of pending) {
            if (entry.terminalError !== undefined) awaiter.reject(entry.terminalError);
            else if (entry.quarantineError !== undefined) awaiter.reject(entry.quarantineError);
            else awaiter.resolve(entry.handle);
        }
    }

    /** Track a fully-settled terminal entry for bounded queryability, evicting the oldest terminal entry when over {@link maxTerminalEntries}. Live coordination is complete; the durable mirror (SQL async_jobs) retains full history. */
    private reapTerminalJob(entry: JobEntry): void {
        if (entry.cleanupPending || entry.preparationPending) return;
        if (!TERMINAL.has(entry.handle.status) && entry.terminalError === undefined && entry.quarantineError === undefined) {
            return;
        }
        const jobId = entry.handle.jobId;
        if (this.terminalOrder.includes(jobId)) return;
        this.terminalOrder.push(jobId);
        while (this.terminalOrder.length > this.maxTerminalEntries) {
            const oldestId = this.terminalOrder.shift();
            if (oldestId !== undefined) this.jobs.delete(oldestId);
        }
    }

    private removeFromQueue(jobId: string): void {
        const idx = this.queue.indexOf(jobId);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
        }
    }

    private removeSignalAbort(entry: JobEntry): void {
        if (entry.signal === undefined || entry.signalAbort === undefined) return;
        entry.signal.removeEventListener('abort', entry.signalAbort);
        entry.signalAbort = undefined;
    }

    private armSignal(entry: JobEntry): void {
        if (entry.signal === undefined || entry.signalAbort !== undefined || entry.cancellationPending) return;
        if (entry.signal.aborted) {
            this.applyCancellation(entry, 'cancelled');
            return;
        }
        const abort = (): void => this.applyCancellation(entry, 'cancelled');
        entry.signalAbort = abort;
        entry.signal.addEventListener('abort', abort, { once: true });
    }

    private recordCancellationPreparationFailure(entry: JobEntry, error: unknown): void {
        const priorFailure = entry.terminalError ?? entry.quarantineError ?? entry.primaryFailure?.error;
        if (priorFailure === undefined) {
            entry.primaryFailure = { error };
            return;
        }
        const failure = new AsyncJobCleanupError(error, priorFailure);
        entry.primaryFailure = { error: failure };
        entry.terminalError = failure;
    }

    private notifyTerminatedBeforeStart(entry: JobEntry): void {
        if (entry.terminatedBeforeStartNotified) return;
        entry.terminatedBeforeStartNotified = true;
        entry.onTerminatedBeforeStart?.();
    }

    private drainQueue(): void {
        while (this.active < this.maxConcurrency && this.queue.length > 0) {
            const nextId = this.queue.shift();
            if (nextId === undefined) break;
            const entry = this.jobs.get(nextId);
            if (entry === undefined || entry.handle.status !== 'queued') continue;
            this.runJob(entry);
        }
    }

    private recordJob(entry: JobEntry): void {
        void this.mirror?.recordJob(snapshotJobHandle(entry.handle));
    }

    private trackRun(run: Promise<void>): void {
        this.pendingRuns.add(run);
        void run.finally(() => this.pendingRuns.delete(run)).catch(() => undefined);
    }

    private trackSettlement(settlement: Promise<void>): void {
        this.pendingSettlements.add(settlement);
        void settlement.finally(() => this.pendingSettlements.delete(settlement)).catch(() => undefined);
    }
}

type JobExecutionOutcome =
    | {
          readonly kind: 'result';
          readonly result: { readonly status: 'completed' | 'failed'; readonly output: string };
      }
    | { readonly kind: 'error'; readonly error: unknown };

type TerminalBackgroundJobHandle = BackgroundJobHandle & {
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly completedAt: string;
};

function terminalJobHandle(entry: JobEntry, outcome: JobExecutionOutcome): TerminalBackgroundJobHandle {
    const completedAt = new Date().toISOString();
    if (entry.cancellationPending) {
        return { ...entry.handle, status: 'cancelled', completedAt };
    }
    if (outcome.kind === 'result') {
        return { ...entry.handle, status: outcome.result.status, result: outcome.result, completedAt };
    }
    return {
        ...entry.handle,
        status: 'failed',
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        completedAt,
    };
}

function applyTerminalJobHandle(target: BackgroundJobHandle, terminal: TerminalBackgroundJobHandle): void {
    target.status = terminal.status;
    target.completedAt = terminal.completedAt;
    if (terminal.result !== undefined) target.result = terminal.result;
    if (terminal.error !== undefined) target.error = terminal.error;
    if (terminal.cancellationReason !== undefined) target.cancellationReason = terminal.cancellationReason;
}

function applySettlementFailure(target: BackgroundJobHandle, error: unknown): void {
    target.status = 'failed';
    target.completedAt = new Date().toISOString();
    target.error = error instanceof Error ? error.message : String(error);
    delete target.result;
}

function snapshotJobHandle(handle: BackgroundJobHandle): BackgroundJobHandle {
    return {
        ...handle,
        ...(handle.result !== undefined ? { result: { ...handle.result } } : {}),
    };
}
