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
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import type { SessionControlAttachment, SessionControlHost } from '../runtime/session-control-host.js';
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
}

export class QuarantinedJobSettlementError extends Error {
    readonly jobId: string;

    constructor(jobId: string) {
        super(`job settlement quarantined: ${jobId}`);
        this.name = 'QuarantinedJobSettlementError';
        this.jobId = jobId;
    }
}

interface JobEntry {
    readonly handle: BackgroundJobHandle;
    readonly execute: JobExecuteFn;
    readonly controller: AbortController;
    readonly awaiters: Array<{
        readonly resolve: (handle: BackgroundJobHandle) => void;
        readonly reject: (error: Error) => void;
    }>;
    cancellationPending: boolean;
    quarantineError?: QuarantinedJobSettlementError;
    controlAttachment?: SessionControlAttachment;
    readonly signal?: AbortSignal;
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

    constructor(
        private readonly maxConcurrency: number = 4,
        options: AsyncJobManagerOptions = {},
    ) {
        this.mirror = options.mirror;
        this.sessionControlHost = options.sessionControlHost;
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
            controller,
            awaiters: [],
            cancellationPending: false,
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
        };
        this.jobs.set(jobId, entry);
        if (this.sessionControlHost === undefined) this.activateEntry(entry);
        else this.trackPreparation(this.prepareControlledEntry(entry));
        return handle;
    }

    async awaitJob(jobId: string): Promise<BackgroundJobHandle> {
        const entry = this.jobs.get(jobId);
        if (entry === undefined) {
            throw new Error(`unknown job: ${jobId}`);
        }
        if (entry.quarantineError !== undefined) throw entry.quarantineError;
        if (TERMINAL.has(entry.handle.status)) {
            return entry.handle;
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
            this.activateEntry(entry);
        } catch (error: unknown) {
            applySettlementFailure(entry.handle, error);
            this.settleAwaiters(entry);
        }
    }

    private trackPreparation(preparation: Promise<void>): void {
        this.pendingPreparations.add(preparation);
        void preparation.finally(() => this.pendingPreparations.delete(preparation));
    }

    private activateEntry(entry: JobEntry): void {
        this.recordJob(entry);
        if (TERMINAL.has(entry.handle.status)) {
            this.settleAwaiters(entry);
            if (entry.controlAttachment !== undefined) {
                this.trackSettlement(entry.controlAttachment.detach());
            }
            return;
        }
        if (entry.signal !== undefined) {
            if (entry.signal.aborted) {
                this.applyCancellation(entry, 'cancelled');
                return;
            }
            entry.signal.addEventListener('abort', () => this.applyCancellation(entry, 'cancelled'), { once: true });
        }
        this.tryStart(entry);
    }

    private runJob(entry: JobEntry): void {
        this.active++;
        entry.handle.status = 'running';
        this.recordJob(entry);

        const run = entry
            .execute(entry.controller.signal, entry.handle.controlEpoch)
            .then(
                (result) => this.settleJob(entry, { kind: 'result', result }),
                (error: unknown) => this.settleJob(entry, { kind: 'error', error }),
            )
            .catch((error: unknown) => {
                if (error instanceof QuarantinedJobSettlementError) entry.quarantineError = error;
                else applySettlementFailure(entry.handle, error);
            })
            .finally(async () => {
                this.active--;
                this.settleAwaiters(entry);
                await entry.controlAttachment?.detach();
                this.drainQueue();
            });
        this.trackRun(run);
    }

    private async settleJob(entry: JobEntry, outcome: JobExecutionOutcome): Promise<void> {
        const terminal = terminalJobHandle(entry, outcome);
        const fence = entry.handle.controlEpoch?.callbackFence;
        if (fence === undefined) {
            applyTerminalJobHandle(entry.handle, terminal);
            await this.mirror?.recordJob(entry.handle);
            return;
        }
        const mirror = this.mirror;
        if (mirror === undefined) {
            applySettlementFailure(entry.handle, new Error('controlled job persistence mirror is required'));
            return;
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
    }

    private applyCancellation(entry: JobEntry, reason: string): void {
        if (TERMINAL.has(entry.handle.status)) return;

        const wasQueued = entry.handle.status === 'queued';
        if (wasQueued) {
            this.removeFromQueue(entry.handle.jobId);
            this.settleQueuedCancellation(entry, reason);
            return;
        }
        entry.handle.cancellationReason = reason;
        entry.cancellationPending = true;
        entry.controller.abort();
        if (reason !== 'operator_aborted') {
            entry.handle.status = 'cancelled';
            this.recordJob(entry);
        }
        // If running: the execute promise's .finally will manage active count,
        // resolve awaiters, and drain the queue.
    }

    private applyOperatorCancellation(entry: JobEntry): void {
        if (TERMINAL.has(entry.handle.status)) return;
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
            this.settleAwaiters(entry);
            if (entry.controlAttachment !== undefined) {
                this.trackSettlement(entry.controlAttachment.detach());
            }
            return;
        }
        const mirror = this.mirror;
        if (mirror === undefined) {
            applySettlementFailure(entry.handle, new Error('controlled job persistence mirror is required'));
            this.settleAwaiters(entry);
            if (entry.controlAttachment !== undefined) {
                this.trackSettlement(entry.controlAttachment.detach());
            }
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
                    if (settlement.accepted) applyTerminalJobHandle(entry.handle, terminal);
                    else entry.quarantineError = new QuarantinedJobSettlementError(entry.handle.jobId);
                },
                (error: unknown) => applySettlementFailure(entry.handle, error),
            )
            .finally(async () => {
                this.settleAwaiters(entry);
                await entry.controlAttachment?.detach();
            });
        this.trackSettlement(settlement);
    }

    private settleAwaiters(entry: JobEntry): void {
        if (entry.awaiters.length === 0) return;
        const pending = entry.awaiters.splice(0);
        for (const awaiter of pending) {
            if (entry.quarantineError !== undefined) awaiter.reject(entry.quarantineError);
            else awaiter.resolve(entry.handle);
        }
    }

    private removeFromQueue(jobId: string): void {
        const idx = this.queue.indexOf(jobId);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
        }
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
        void this.mirror?.recordJob(entry.handle);
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
