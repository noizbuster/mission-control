import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    EvalPythonKernel,
    type PythonChildProcess,
    type PythonProcessTreeTerminateFn,
    type PythonSpawnFn,
} from './eval-python-kernel.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const KERNEL_INIT_TIMEOUT_MS = 10_000;
const KERNEL_PID = 4312;

describe('EvalPythonKernel lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns exit 124 after awaiting timeout termination even when stdout stays open', async () => {
        // Given
        vi.useFakeTimers();
        const child = new FakePythonChild();
        const terminate = vi.fn<PythonProcessTreeTerminateFn>(async () => undefined);
        const kernel = createKernel(child, terminate);

        // When
        const pending = kernel.runCode({ code: 'while True: pass', timeoutMs: 25 });
        await vi.advanceTimersByTimeAsync(25);
        const result = await pending;

        // Then
        expect(result).toEqual({ output: '', exitCode: 124, truncated: false, timedOut: true });
        expect(terminate).toHaveBeenCalledWith(KERNEL_PID);
        expect(child.stdout.readableEnded).toBe(false);
    });

    it('terminates an existing kernel for a pre-aborted run and returns exit 130', async () => {
        // Given
        const child = new FakePythonChild({ respondToRuns: 1 });
        const terminate = vi.fn<PythonProcessTreeTerminateFn>(async () => undefined);
        const kernel = createKernel(child, terminate);
        await kernel.runCode({ code: 'pass' });
        const controller = new AbortController();
        controller.abort();

        // When
        const result = await kernel.runCode({ code: 'while True: pass', signal: controller.signal });

        // Then
        expect(result).toEqual({ output: 'Execution aborted\n', exitCode: 130, truncated: false, timedOut: false });
        expect(terminate).toHaveBeenCalledWith(KERNEL_PID);
    });

    it('awaits mid-run abort termination and removes the abort listener', async () => {
        // Given
        const child = new FakePythonChild();
        const termination = createDeferred<void>();
        const terminate = vi.fn<PythonProcessTreeTerminateFn>(() => termination.promise);
        const kernel = createKernel(child, terminate);
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
        const pending = kernel.runCode({ code: 'while True: pass', signal: controller.signal });
        await child.waitForRun();

        // When
        controller.abort();
        let settled = false;
        void pending.then(() => {
            settled = true;
        });
        await Promise.resolve();

        // Then
        expect(settled).toBe(false);
        termination.resolve();
        const result = await pending;
        expect(result).toEqual({ output: 'Execution aborted\n', exitCode: 130, truncated: false, timedOut: false });
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('awaits process-tree termination on close', async () => {
        // Given
        const child = new FakePythonChild({ respondToRuns: 1 });
        const termination = createDeferred<void>();
        const terminate = vi.fn<PythonProcessTreeTerminateFn>(() => termination.promise);
        const kernel = createKernel(child, terminate);
        await kernel.runCode({ code: 'pass' });

        // When
        const closing = kernel.close();
        let settled = false;
        void closing.then(() => {
            settled = true;
        });
        await Promise.resolve();

        // Then
        expect(settled).toBe(false);
        termination.resolve();
        await closing;
        expect(terminate).toHaveBeenCalledWith(KERNEL_PID);
        expect(child.listenerCount('exit')).toBe(0);
        expect(child.listenerCount('error')).toBe(0);
    });

    it('terminates the process tree before reporting an initialization timeout', async () => {
        // Given
        vi.useFakeTimers();
        const child = new FakePythonChild({ signalReady: false });
        const terminate = vi.fn<PythonProcessTreeTerminateFn>(async () => undefined);
        const kernel = createKernel(child, terminate);

        // When
        const pending = kernel.runCode({ code: 'pass' });
        await vi.advanceTimersByTimeAsync(KERNEL_INIT_TIMEOUT_MS);
        const result = await pending;

        // Then
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain('python kernel init timed out');
        expect(terminate).toHaveBeenCalledWith(KERNEL_PID);
    });

    it('coalesces repeated termination and makes every caller await the same work', async () => {
        // Given
        const child = new FakePythonChild({ respondToRuns: 1 });
        const termination = createDeferred<void>();
        const terminate = vi.fn<PythonProcessTreeTerminateFn>(() => termination.promise);
        const kernel = createKernel(child, terminate);
        await kernel.runCode({ code: 'pass' });

        // When
        const first = kernel.close();
        const second = kernel.close();
        await Promise.resolve();

        // Then
        expect(terminate).toHaveBeenCalledTimes(1);
        termination.resolve();
        await Promise.all([first, second]);
    });
});

function createKernel(child: FakePythonChild, terminateProcessTree: PythonProcessTreeTerminateFn): EvalPythonKernel {
    const spawn: PythonSpawnFn = () => child;
    return new EvalPythonKernel({ spawn, terminateProcessTree });
}

type FakePythonChildOptions = {
    readonly signalReady?: boolean;
    readonly respondToRuns?: number;
};

class FakePythonChild implements PythonChildProcess {
    readonly pid: number | undefined = KERNEL_PID;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly #events = new EventEmitter();
    readonly #runSeen = createDeferred<void>();
    #remainingRunResponses: number;

    readonly stdin = {
        write: (chunk: string): boolean => {
            if (chunk.includes('"type":"run"')) {
                this.#runSeen.resolve();
                if (this.#remainingRunResponses > 0) {
                    this.#remainingRunResponses -= 1;
                    queueMicrotask(() => this.stdout.write('{"type":"result","ok":true,"output":""}\n'));
                }
            }
            return true;
        },
        end: (): void => undefined,
    };

    constructor(options: FakePythonChildOptions = {}) {
        this.#remainingRunResponses = options.respondToRuns ?? 0;
        if (options.signalReady !== false) {
            queueMicrotask(() => this.stdout.write('{"type":"ready"}\n'));
        }
    }

    kill(): void {}

    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
        this.#events.on(event, listener);
    }

    once(event: 'error', listener: (error: Error) => void): void {
        this.#events.once(event, listener);
    }

    off(
        event: 'exit' | 'error',
        listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
    ): void {
        this.#events.off(event, listener);
    }

    listenerCount(event: 'exit' | 'error'): number {
        return this.#events.listenerCount(event);
    }

    async waitForRun(): Promise<void> {
        await this.#runSeen.promise;
    }
}

type Deferred<T> = {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    if (resolvePromise === undefined) {
        throw new Error('test deferred initialization failed');
    }
    return { promise, resolve: resolvePromise };
}
