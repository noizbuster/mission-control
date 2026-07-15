/**
 * Persistent eval context coordinating two runtimes: a JavaScript VM owned by a
 * `node:worker_threads` worker, and a persistent Python kernel subprocess.
 *
 * The JS worker owns a `vm.createContext()` global context whose state survives
 * across `runCode` calls, so `var` declarations persist between cells. Output
 * (console writes + the completion value of the last expression) is captured,
 * capped at 64 KiB, and returned as an `EvalRunResult`. Tool re-entry is driven
 * over the worker boundary: a `tool-call` message routes through the injected
 * `EvalToolBridge` and the reply is posted back as a `tool-reply`, so cells can
 * `await read(...)` (top-level await is enabled for cells that use it).
 *
 * Python cells are served by a lazily-spawned `EvalPythonKernel` that shares the
 * same bridge. Timeouts and aborts terminate the worker / kernel (state is lost)
 * and the next call respawns a fresh context. Simplified relative to oh-my-pi's
 * 621-LOC pool: no session-keyed multi-worker pool, no inline fallback.
 */
// allow: SIZE_OK -- HEAD 366 -> current 366 pure LOC; worker lifecycle remains one tightly coupled state machine (init, execution, timeout, recovery, teardown); splitting further would sever state transitions that must stay atomic.

import { EvalPythonKernel, type PythonSpawnFn } from './eval-python-kernel.js';
import { type EvalLanguage } from './eval-schemas.js';
import type { EvalToolBridge } from './eval-tool-bridge.js';
import { type EvalWorkerInbound, type EvalWorkerOutbound, parseEvalWorkerOutbound } from './eval-worker-protocol.js';
import { EVAL_WORKER_SOURCE } from './eval-worker-source.js';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const OUTPUT_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const WORKER_INIT_TIMEOUT_MS = 10_000;
const OK_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const TIMEOUT_EXIT_CODE = 124;
const ABORT_EXIT_CODE = 130;

export type EvalRunOptions = {
    readonly code: string;
    readonly language?: EvalLanguage;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly reset?: boolean;
};

export type EvalRunResult = {
    readonly output: string;
    readonly exitCode: number;
    readonly truncated: boolean;
    readonly timedOut: boolean;
};

export type EvalContextManagerOptions = {
    readonly sessionId?: string;
    readonly bridge?: EvalToolBridge;
    readonly pythonBin?: string;
    readonly pythonSpawn?: PythonSpawnFn;
};

interface RunHandle {
    readonly runId: string;
    output: string;
    settled: boolean;
    readonly resolve: (result: EvalRunResult) => void;
}

export class EvalContextManager {
    readonly #sessionId: string;
    readonly #bridge: EvalToolBridge | undefined;
    readonly #pythonOptions: { readonly pythonBin?: string; readonly pythonSpawn?: PythonSpawnFn };
    #worker: Worker | null = null;
    #python: EvalPythonKernel | null = null;
    #runs = new Map<string, RunHandle>();
    #readyPromise: Promise<void> | null = null;
    #readyResolve: ((value: void) => void) | null = null;
    #readyReject: ((error: Error) => void) | null = null;
    #readySettled = false;
    #closed = false;

    constructor(options?: EvalContextManagerOptions) {
        this.#sessionId = options?.sessionId ?? `eval-${randomUUID()}`;
        this.#bridge = options?.bridge;
        this.#pythonOptions = {
            ...(options?.pythonBin !== undefined ? { pythonBin: options.pythonBin } : {}),
            ...(options?.pythonSpawn !== undefined ? { pythonSpawn: options.pythonSpawn } : {}),
        };
    }

    async runCode(options: EvalRunOptions): Promise<EvalRunResult> {
        if (this.#closed) {
            return failureResult('eval context manager is closed', false, ERROR_EXIT_CODE);
        }
        if (options.reset) {
            await this.#resetLanguage(options.language ?? 'js');
            if (options.code.length === 0) {
                return { output: '', exitCode: OK_EXIT_CODE, truncated: false, timedOut: false };
            }
        }
        if ((options.language ?? 'js') === 'py') {
            return await this.#runPython(options);
        }
        return await this.#runJs(options);
    }

    async reset(): Promise<void> {
        await this.#resetLanguage('js');
        await this.#resetLanguage('py');
    }

    async close(): Promise<void> {
        this.#closed = true;
        await Promise.all([this.#terminateWorker('close'), this.#python?.close()]);
    }

    async #runPython(options: EvalRunOptions): Promise<EvalRunResult> {
        if (this.#python === null) {
            this.#python = new EvalPythonKernel({
                ...(this.#bridge !== undefined ? { bridge: this.#bridge } : {}),
                ...this.#pythonOptions,
            });
        }
        return await this.#python.runCode({
            code: options.code,
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
    }

    async #runJs(options: EvalRunOptions): Promise<EvalRunResult> {
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

    async #resetLanguage(language: EvalLanguage): Promise<void> {
        if (language === 'py') {
            if (this.#python !== null) {
                await this.#python.reset().catch(() => undefined);
            }
            return;
        }
        await this.#terminateWorker('reset');
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
                void this.#serviceJsToolCall(parsed);
                return;
        }
    }

    async #serviceJsToolCall(parsed: Extract<EvalWorkerOutbound, { type: 'tool-call' }>): Promise<void> {
        const worker = this.#worker;
        if (worker === null) {
            return;
        }
        let reply: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };
        if (this.#bridge === undefined) {
            reply = { ok: false, error: `eval tool bridge unavailable for call: ${parsed.name}` };
        } else {
            try {
                const value = await this.#bridge.handleToolCall(parsed.name, parsed.args);
                reply = { ok: true, value };
            } catch (error) {
                reply = { ok: false, error: messageOf(error) };
            }
        }
        const replyMessage: EvalWorkerInbound = { type: 'tool-reply', id: parsed.id, reply };
        try {
            worker.postMessage(replyMessage);
        } catch {
            // Worker may already be gone during teardown.
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
