import type { EvalRunResult } from './eval-context-manager';
import {
    createPythonProcessTreeTerminator,
    defaultPythonSpawn,
    type PythonChildProcess,
    type PythonProcessTreeTerminateFn,
    type PythonSpawnFn,
} from './eval-python-process-tree';
import {
    createPythonProtocolLineReader,
    type PythonKernelParsedResult,
    type PythonKernelRunSettlement,
    PythonProtocolSession,
} from './eval-python-protocol';
import { EVAL_PYTHON_RUNNER_SOURCE } from './eval-python-runner-source';
import type { EvalToolBridge } from './eval-tool-bridge';

export {
    createPythonProcessTreeTerminator,
    type ProcessTreeCommandRunFn,
    type PythonChildProcess,
    type PythonProcessTreeTerminateFn,
    PythonProcessTreeTerminationError,
    type PythonSpawnFn,
    pythonSpawnOptionsFor,
} from './eval-python-process-tree';

const DEFAULT_PYTHON_BIN = 'python3';
const DEFAULT_TIMEOUT_MS = 30_000;
const KERNEL_INIT_TIMEOUT_MS = 10_000;
const OK_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const TIMEOUT_EXIT_CODE = 124;
const ABORT_EXIT_CODE = 130;
const OUTPUT_CAP = 64 * 1024;

export type EvalPythonRunOptions = {
    readonly code: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
};

export type EvalPythonKernelOptions = {
    readonly bridge?: EvalToolBridge;
    readonly pythonBin?: string;
    readonly spawn?: PythonSpawnFn;
    readonly terminateProcessTree?: PythonProcessTreeTerminateFn;
};

export class EvalPythonKernel {
    readonly #bridge: EvalToolBridge | undefined;
    readonly #pythonBin: string;
    readonly #spawn: PythonSpawnFn;
    readonly #terminateProcessTree: PythonProcessTreeTerminateFn;
    #child: PythonChildProcess | null = null;
    #session: PythonProtocolSession | null = null;
    #readyPromise: Promise<void> | null = null;
    #removeChildListeners: (() => void) | null = null;
    #terminationPromise: Promise<void> | null = null;
    #dead = false;

    constructor(options: EvalPythonKernelOptions = {}) {
        this.#bridge = options.bridge;
        this.#pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
        this.#spawn = options.spawn ?? defaultPythonSpawn;
        this.#terminateProcessTree = options.terminateProcessTree ?? createPythonProcessTreeTerminator();
    }

    async runCode(options: EvalPythonRunOptions): Promise<EvalRunResult> {
        if (options.signal?.aborted === true) {
            await this.#terminate();
            return failureResult('Execution aborted', ABORT_EXIT_CODE);
        }
        if (this.#dead) {
            await this.#awaitTermination();
            return failureResult('python kernel is dead; restarting on next call', ERROR_EXIT_CODE);
        }
        try {
            await this.#ensureReady();
        } catch (error) {
            await this.#terminate();
            return failureResult(messageOf(error), ERROR_EXIT_CODE);
        }
        const child = this.#child;
        const session = this.#session;
        if (child === null || session === null) {
            return failureResult('python kernel unavailable', ERROR_EXIT_CODE);
        }

        const settlement = await session.request(
            { type: 'run', code: options.code },
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            options.signal,
        );
        return resultForSettlement(settlement);
    }

    async reset(): Promise<void> {
        const child = this.#child;
        const session = this.#session;
        if (child === null || session === null || this.#dead) {
            await this.#terminate();
            return;
        }
        const settlement = await session.request({ type: 'reset' }, DEFAULT_TIMEOUT_MS, undefined);
        if (settlement.kind !== 'result' || !settlement.result.ok) {
            await this.#terminate();
        }
    }

    async close(): Promise<void> {
        await this.#terminate();
    }

    async #ensureReady(): Promise<void> {
        if (this.#child !== null && this.#readyPromise !== null) {
            await this.#readyPromise;
            return;
        }
        this.#spawnKernel();
        const readyPromise = this.#readyPromise;
        if (readyPromise === null) {
            throw new Error('failed to start python kernel');
        }
        await readyPromise;
    }

    #spawnKernel(): void {
        const child = this.#spawn([this.#pythonBin, '-I', '-B', '-c', EVAL_PYTHON_RUNNER_SOURCE]);
        const reader = createPythonProtocolLineReader(child.stdout);
        const session = new PythonProtocolSession({
            child,
            reader,
            bridge: this.#bridge,
            terminate: async () => await this.#terminate(),
        });
        const ready = createDeferred<void>();
        let settled = false;
        const settleReady = (error: Error | undefined): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(readyTimer);
            if (error === undefined) {
                ready.resolve();
                return;
            }
            ready.reject(error);
        };
        const terminateThenSettle = (error: Error): void => {
            void this.#terminate().then(
                () => settleReady(error),
                (terminationError: unknown) => settleReady(toError(terminationError)),
            );
        };
        const onError = (error: Error): void => terminateThenSettle(error);
        const onExit = (code: number | null): void => {
            terminateThenSettle(new Error(`python kernel exited before ready (code=${String(code)})`));
        };
        const readyTimer = setTimeout(() => {
            terminateThenSettle(new Error('python kernel init timed out'));
        }, KERNEL_INIT_TIMEOUT_MS);

        this.#child = child;
        this.#session = session;
        this.#readyPromise = ready.promise;
        child.once('error', onError);
        child.on('exit', onExit);
        this.#removeChildListeners = () => {
            child.off('error', onError);
            child.off('exit', onExit);
        };

        void session.readMessage().then(
            (firstMessage) => {
                if (firstMessage?.type === 'ready') {
                    settleReady(undefined);
                    return;
                }
                terminateThenSettle(new Error('python kernel did not signal ready'));
            },
            (error: unknown) => terminateThenSettle(toError(error)),
        );
    }

    #terminate(): Promise<void> {
        if (this.#terminationPromise !== null) {
            return this.#terminationPromise;
        }
        this.#dead = true;
        const child = this.#child;
        this.#child = null;
        this.#readyPromise = null;
        this.#session?.stop();
        this.#session = null;
        this.#removeChildListeners?.();
        this.#removeChildListeners = null;
        const termination = Promise.resolve().then(async () => {
            await this.#terminateProcessTree(child?.pid);
        });
        this.#terminationPromise = termination;
        void termination.then(undefined, () => undefined);
        return termination;
    }

    async #awaitTermination(): Promise<void> {
        if (this.#terminationPromise !== null) {
            await this.#terminationPromise;
        }
    }
}

function resultForSettlement(settlement: PythonKernelRunSettlement): EvalRunResult {
    switch (settlement.kind) {
        case 'result':
            return shapeResult(settlement.result);
        case 'timed_out':
            return failureResult('python kernel timed out', TIMEOUT_EXIT_CODE);
        case 'aborted':
            return failureResult('Execution aborted', ABORT_EXIT_CODE);
        case 'exited':
            return failureResult('python kernel exited without a result', ERROR_EXIT_CODE);
    }
}

function shapeResult(parsed: PythonKernelParsedResult): EvalRunResult {
    let output = parsed.output;
    if (!parsed.ok && parsed.error !== undefined && parsed.error.length > 0) {
        output = `${output}${parsed.error}\n`;
    }
    const truncated = output.length >= OUTPUT_CAP;
    if (output.length > OUTPUT_CAP) {
        output = output.slice(0, OUTPUT_CAP);
    }
    return { output, exitCode: parsed.ok ? OK_EXIT_CODE : ERROR_EXIT_CODE, truncated, timedOut: false };
}

function failureResult(message: string, exitCode: number): EvalRunResult {
    if (exitCode === TIMEOUT_EXIT_CODE) {
        return { output: '', exitCode, truncated: false, timedOut: true };
    }
    return {
        output: `${message}\n`,
        exitCode,
        truncated: false,
        timedOut: false,
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

type Deferred<T> = {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    let rejectPromise: ((error: unknown) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    if (resolvePromise === undefined || rejectPromise === undefined) {
        throw new Error('python kernel deferred initialization failed');
    }
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}
