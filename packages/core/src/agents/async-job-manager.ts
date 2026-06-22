/**
 * AsyncJobManager - bounds concurrent background child-agent execution via a
 * maxConcurrency semaphore. Jobs beyond the limit are queued and start when a
 * running job finishes. Cancellation is cooperative: each job owns an
 * AbortController whose signal is forwarded to the execute function, so it can
 * shut down promptly when {@link cancelJob} is called or the caller-provided
 * signal aborts.
 *
 * In-memory only. Persistence is todo 32.
 */
import { randomBytes } from 'node:crypto';

export interface BackgroundJobHandle {
    readonly jobId: string;
    readonly sessionId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    result?: { status: 'completed' | 'failed'; output: string };
    error?: string;
    readonly startedAt: string;
    completedAt?: string;
}

/**
 * Work function invoked when a job gets a concurrency slot. The signal is
 * aborted on cancellation so the function can cooperatively release resources.
 */
export type JobExecuteFn = (signal: AbortSignal) => Promise<{ status: 'completed' | 'failed'; output: string }>;

export interface StartJobInput {
    readonly sessionId: string;
    readonly execute: JobExecuteFn;
    /** When this signal aborts the job is cancelled automatically. */
    readonly signal?: AbortSignal;
}

interface JobEntry {
    readonly handle: BackgroundJobHandle;
    readonly execute: JobExecuteFn;
    readonly controller: AbortController;
    readonly awaiters: Array<(handle: BackgroundJobHandle) => void>;
}

const TERMINAL: ReadonlySet<BackgroundJobHandle['status']> = new Set(['completed', 'failed', 'cancelled']);

export class AsyncJobManager {
    private readonly jobs = new Map<string, JobEntry>();
    private readonly queue: string[] = [];
    private active = 0;

    constructor(private readonly maxConcurrency: number = 4) {}

    startJob(input: StartJobInput): BackgroundJobHandle {
        const jobId = `job_${Date.now()}_${randomBytes(4).toString('hex')}`;
        const controller = new AbortController();
        const handle: BackgroundJobHandle = {
            jobId,
            sessionId: input.sessionId,
            status: 'queued',
            startedAt: new Date().toISOString(),
        };
        const entry: JobEntry = { handle, execute: input.execute, controller, awaiters: [] };
        this.jobs.set(jobId, entry);

        if (input.signal !== undefined) {
            if (input.signal.aborted) {
                this.applyCancellation(entry);
                return handle;
            }
            input.signal.addEventListener('abort', () => this.applyCancellation(entry), { once: true });
        }

        this.tryStart(entry);
        return handle;
    }

    async awaitJob(jobId: string): Promise<BackgroundJobHandle> {
        const entry = this.jobs.get(jobId);
        if (entry === undefined) {
            throw new Error(`unknown job: ${jobId}`);
        }
        if (TERMINAL.has(entry.handle.status)) {
            return entry.handle;
        }
        return new Promise<BackgroundJobHandle>((resolve) => {
            entry.awaiters.push(resolve);
        });
    }

    cancelJob(jobId: string): void {
        const entry = this.jobs.get(jobId);
        if (entry !== undefined) {
            this.applyCancellation(entry);
        }
    }

    listJobs(): readonly BackgroundJobHandle[] {
        return Array.from(this.jobs.values(), (entry) => entry.handle);
    }

    getActiveCount(): number {
        return this.active;
    }

    // --- internals ----------------------------------------------------------

    private tryStart(entry: JobEntry): void {
        if (this.active >= this.maxConcurrency) {
            this.queue.push(entry.handle.jobId);
            return;
        }
        this.runJob(entry);
    }

    private runJob(entry: JobEntry): void {
        this.active++;
        entry.handle.status = 'running';

        entry
            .execute(entry.controller.signal)
            .then((result) => {
                if (entry.handle.status === 'cancelled') return;
                entry.handle.status = result.status;
                entry.handle.result = result;
            })
            .catch((error: unknown) => {
                if (entry.handle.status === 'cancelled') return;
                entry.handle.status = 'failed';
                entry.handle.error = error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
                if (entry.handle.completedAt === undefined) {
                    entry.handle.completedAt = new Date().toISOString();
                }
                this.active--;
                this.resolveAwaiters(entry);
                this.drainQueue();
            });
    }

    private applyCancellation(entry: JobEntry): void {
        if (TERMINAL.has(entry.handle.status)) return;

        const wasQueued = entry.handle.status === 'queued';
        entry.controller.abort();
        entry.handle.status = 'cancelled';
        entry.handle.completedAt = new Date().toISOString();

        if (wasQueued) {
            // Queued job never entered runJob, so no promise .finally to handle
            // cleanup. Resolve awaiters directly here.
            this.removeFromQueue(entry.handle.jobId);
            this.resolveAwaiters(entry);
        }
        // If running: the execute promise's .finally will manage active count,
        // resolve awaiters, and drain the queue.
    }

    private resolveAwaiters(entry: JobEntry): void {
        if (entry.awaiters.length === 0) return;
        const pending = entry.awaiters.splice(0);
        for (const resolve of pending) {
            resolve(entry.handle);
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
}
