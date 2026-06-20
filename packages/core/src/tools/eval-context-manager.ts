/**
 * Persistent JavaScript eval sandbox built on `node:worker_threads` + `node:vm`.
 *
 * A single worker owns a `vm.createContext()` sandbox whose global scope survives
 * across `runCode` calls, so `var` declarations persist between cells. Output
 * (console writes + the completion value of the last expression) is captured,
 * capped at 64 KiB, and returned as an `EvalRunResult`. Timeouts and aborts
 * terminate the worker (state is lost) and the next call respawns a fresh
 * context. Simplified relative to oh-my-pi's 621-LOC pool: no tool re-entry,
 * no session-keyed multi-worker pool, no inline fallback.
 */
// allow: SIZE_OK — single-responsibility worker-lifecycle manager (init handshake,
// run execution, timeout/abort race, worker-death recovery, teardown, result
// shaping). Size reflects necessary lifecycle handling, not mixed concerns;
// further splits would sever tightly-coupled lifecycle pieces.

import { type EvalWorkerInbound, type EvalWorkerOutbound, parseEvalWorkerOutbound } from './eval-worker-protocol.js';
import { EVAL_WORKER_SOURCE } from './eval-worker-source.js';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

const OUTPUT_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const WORKER_INIT_TIMEOUT_MS = 10_000;
const OK_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const TIMEOUT_EXIT_CODE = 124;
const ABORT_EXIT_CODE = 130;

export type EvalRunOptions = {
    readonly code: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
};

export type EvalRunResult = {
    readonly output: string;
    readonly exitCode: number;
    readonly truncated: boolean;
    readonly timedOut: boolean;
};

interface RunHandle {
    readonly runId: string;
    output: string;
    settled: boolean;
    readonly resolve: (result: EvalRunResult) => void;
}

export class EvalContextManager {
    readonly #sessionId: string;
    #worker: Worker | null = null;
    #runs = new Map<string, RunHandle>();
    #readyPromise: Promise<void> | null = null;
    #readyResolve: ((value: void) => void) | null = null;
    #readyReject: ((error: Error) => void) | null = null;
    #readySettled = false;
    #closed = false;

    constructor(options?: { readonly sessionId?: string }) {
        this.#sessionId = options?.sessionId ?? `eval-${randomUUID()}`;
    }

    async runCode(options: EvalRunOptions): Promise<EvalRunResult> {
        if (this.#closed) {
            return failureResult('eval context manager is closed', false, ERROR_EXIT_CODE);
        }
        try {
            await this.#ensureReady();
        } catch (error) {
            return failureResult(messageOf(error), false, ERROR_EXIT_CODE);
        }
        const worker = this.#worker;
        if (worker === null) {
            return failureResult('eval worker unavailable', false, ERROR_EXIT_CODE);
        }
        const runId = `r-${randomUUID()}`;
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        return await this.#executeRun(worker, runId, options.code, timeoutMs, options.signal);
    }

    async reset(): Promise<void> {
        await this.#terminateWorker('reset');
    }

    async close(): Promise<void> {
        this.#closed = true;
        await this.#terminateWorker('close');
    }

    async #ensureReady(): Promise<void> {
        if (this.#worker !== null && this.#readyPromise !== null) {
            await this.#readyPromise;
            return;
        }
        this.#spawn();
        if (this.#readyPromise === null) {
            throw new Error('failed to start eval worker');
        }
        await this.#readyPromise;
    }

    #spawn(): void {
        const worker = new Worker(EVAL_WORKER_SOURCE, { eval: true });
        this.#worker = worker;
        this.#readySettled = false;
        const { promise, resolve, reject } = createDeferred<void>();
        this.#readyPromise = promise;
        this.#readyResolve = resolve;
        this.#readyReject = reject;

        worker.on('message', (message: unknown) => this.#handleMessage(message));
        worker.once('error', (error: unknown) => this.#handleWorkerError(error));
        worker.once('exit', (code: number) => this.#handleWorkerExit(code));

        const initTimer = setTimeout(() => {
            if (!this.#readySettled) {
                this.#settleReady(new Error('eval worker init timed out'));
                void this.#terminateWorker('init-timeout');
            }
        }, WORKER_INIT_TIMEOUT_MS);

        const initMessage: EvalWorkerInbound = { type: 'init', sessionId: this.#sessionId };
        worker.postMessage(initMessage);
        void promise.finally(() => clearTimeout(initTimer));
    }

    #handleMessage(message: unknown): void {
        const parsed = parseEvalWorkerOutbound(message);
        if (parsed === undefined) {
            return;
        }
        switch (parsed.type) {
            case 'ready':
                this.#settleReady(undefined);
                return;
            case 'text': {
                const handle = this.#runs.get(parsed.runId);
                if (handle !== undefined) {
                    appendChunk(handle, parsed.chunk);
                }
                return;
            }
            case 'result':
                this.#settleRunFromResult(parsed);
                return;
            case 'tool-call':
                return;
        }
    }

    #settleReady(value: Error | undefined): void {
        if (this.#readySettled) {
            return;
        }
        this.#readySettled = true;
        if (value === undefined) {
            this.#readyResolve?.();
        } else {
            this.#readyReject?.(value);
        }
    }

    #settleRunFromResult(parsed: Extract<EvalWorkerOutbound, { type: 'result' }>): void {
        const handle = this.#runs.get(parsed.runId);
        if (handle === undefined || handle.settled) {
            return;
        }
        handle.settled = true;
        this.#runs.delete(handle.runId);
        handle.resolve(buildResultFromWorker(handle.output, parsed));
    }

    async #executeRun(
        worker: Worker,
        runId: string,
        code: string,
        timeoutMs: number,
        signal: AbortSignal | undefined,
    ): Promise<EvalRunResult> {
        const { promise, resolve } = createDeferred<EvalRunResult>();
        const handle: RunHandle = { runId, output: '', settled: false, resolve };
        this.#runs.set(runId, handle);

        const finish = (result: EvalRunResult): void => {
            if (handle.settled) {
                return;
            }
            handle.settled = true;
            this.#runs.delete(runId);
            resolve(result);
        };

        const timer = setTimeout(() => {
            finish(timeoutResult());
            void this.#terminateWorker('timeout');
        }, timeoutMs);

        let cleanupAbort = (): void => {};
        if (signal !== undefined) {
            const onAbort = (): void => {
                finish(failureResult('Execution aborted', false, ABORT_EXIT_CODE));
                void this.#terminateWorker('abort');
            };
            if (signal.aborted) {
                queueMicrotask(onAbort);
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
                cleanupAbort = (): void => signal.removeEventListener('abort', onAbort);
            }
        }

        const runMessage: EvalWorkerInbound = { type: 'run', runId, code, timeoutMs };
        try {
            worker.postMessage(runMessage);
        } catch (error) {
            finish(failureResult(messageOf(error), false, ERROR_EXIT_CODE));
        }

        try {
            return await promise;
        } finally {
            clearTimeout(timer);
            cleanupAbort();
        }
    }

    #handleWorkerError(error: unknown): void {
        this.#settleReady(toError(error));
        this.#failPending(messageOf(error));
        this.#markDead();
    }

    #handleWorkerExit(code: number): void {
        if (!this.#readySettled) {
            this.#settleReady(new Error(`eval worker exited before ready (code=${code})`));
        }
        this.#failPending(`eval worker exited (code=${code})`);
        this.#markDead();
    }

    #markDead(): void {
        this.#worker = null;
        this.#readyPromise = null;
        this.#readyResolve = null;
        this.#readyReject = null;
    }

    #failPending(message: string): void {
        for (const runId of this.#runs.keys()) {
            const handle = this.#runs.get(runId);
            if (handle === undefined || handle.settled) {
                continue;
            }
            handle.settled = true;
            this.#runs.delete(runId);
            handle.resolve(failureResult(message, false, ERROR_EXIT_CODE));
        }
    }

    async #terminateWorker(reason: string): Promise<void> {
        const worker = this.#worker;
        this.#markDead();
        this.#failPending(`eval worker terminated (${reason})`);
        if (worker === null) {
            return;
        }
        const closeMessage: EvalWorkerInbound = { type: 'close' };
        try {
            worker.postMessage(closeMessage);
        } catch {
            // Worker may already be gone; fall through to terminate.
        }
        try {
            await worker.terminate();
        } catch {
            // Terminate is best-effort during teardown.
        }
    }
}

function buildResultFromWorker(
    accumulated: string,
    parsed: Extract<EvalWorkerOutbound, { type: 'result' }>,
): EvalRunResult {
    let output = accumulated + parsed.output;
    if (!parsed.ok && parsed.error !== undefined && parsed.error.length > 0) {
        output = `${output}${parsed.error}\n`;
    }
    const truncated = output.length >= OUTPUT_CAP;
    if (output.length > OUTPUT_CAP) {
        output = output.slice(0, OUTPUT_CAP);
    }
    const exitCode = parsed.ok ? OK_EXIT_CODE : ERROR_EXIT_CODE;
    return { output, exitCode, truncated, timedOut: false };
}

function appendChunk(handle: RunHandle, chunk: string): void {
    if (handle.output.length >= OUTPUT_CAP) {
        return;
    }
    if (handle.output.length + chunk.length > OUTPUT_CAP) {
        handle.output = handle.output + chunk.slice(0, OUTPUT_CAP - handle.output.length);
        return;
    }
    handle.output = handle.output + chunk;
}

function timeoutResult(): EvalRunResult {
    return { output: '', exitCode: TIMEOUT_EXIT_CODE, truncated: false, timedOut: true };
}

function failureResult(message: string, timedOut: boolean, exitCode: number): EvalRunResult {
    return { output: `${message}\n`, exitCode, truncated: false, timedOut };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolveFn: ((value: T) => void) | undefined;
    let rejectFn: ((error: Error) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    if (resolveFn === undefined || rejectFn === undefined) {
        throw new Error('eval deferred initialization failed');
    }
    return { promise, resolve: resolveFn, reject: rejectFn };
}
