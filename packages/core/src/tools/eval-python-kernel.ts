/**
 * Persistent Python kernel subprocess for the `eval` tool.
 *
 * Spawns `python3` (or an injected spawn seam) with the inline runner source and
 * drives a synchronous JSON Lines protocol over stdin/stdout. Code executes in a
 * single persistent namespace, so top-level declarations survive across cells.
 * The tool re-entry bridge lets a cell call back into host read-only tools: the
 * runner emits a `tool-call` line, blocks on a stdin readline, and the kernel
 * services it through the injected `EvalToolBridge` before writing the reply.
 *
 * Ported from oh-my-pi's IPython-kernel eval backend (MIT), simplified to a
 * stdin/stdout subprocess instead of a ZMQ kernel, and rewritten to run on the
 * Node runtime with no Bun dependency.
 */

import type { EvalRunResult } from './eval-context-manager.js';
import { EVAL_PYTHON_RUNNER_SOURCE } from './eval-python-runner-source.js';
import { type EvalToolBridge } from './eval-tool-bridge.js';
import { type ChildProcess, spawn } from 'node:child_process';
import { createStreamDecoder } from '../providers/stream-decoder.js';

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

export interface PythonChildProcess {
    readonly stdin: { write(chunk: string): boolean; end(): void };
    readonly stdout: NodeJS.ReadableStream;
    readonly stderr: NodeJS.ReadableStream;
    kill(signal?: NodeJS.Signals): void;
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    once(event: 'error', listener: (error: Error) => void): void;
}

export type PythonSpawnFn = (argv: readonly string[]) => PythonChildProcess;

export type EvalPythonKernelOptions = {
    readonly bridge?: EvalToolBridge;
    readonly pythonBin?: string;
    readonly spawn?: PythonSpawnFn;
};

interface LineReader {
    readLine(): Promise<string | null>;
    stop(): void;
}

function createLineReader(stream: NodeJS.ReadableStream): LineReader {
    const pending: Array<(line: string | null) => void> = [];
    let buffer = '';
    let ended = false;
    const decoder = createStreamDecoder();

    const onData = (chunk: Buffer | string): void => {
        buffer += decoder.decode(chunk);
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const waiter = pending.shift();
            if (waiter !== undefined) {
                waiter(line);
            }
            newlineIndex = buffer.indexOf('\n');
        }
    };
    const onEnd = (): void => {
        ended = true;
        if (buffer.length > 0) {
            const tail = buffer;
            buffer = '';
            const waiter = pending.shift();
            if (waiter !== undefined) {
                waiter(tail);
                return;
            }
        }
        while (pending.length > 0) {
            const waiter = pending.shift();
            if (waiter !== undefined) {
                waiter(null);
            }
        }
    };
    stream.on('data', onData);
    stream.on('end', onEnd);

    return {
        readLine: () =>
            new Promise<string | null>((resolve) => {
                if (ended && pending.length === 0) {
                    resolve(null);
                    return;
                }
                pending.push(resolve);
            }),
        stop: () => {
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
        },
    };
}

interface ParsedResult {
    readonly ok: boolean;
    readonly output: string;
    readonly error: string | undefined;
}

export class EvalPythonKernel {
    readonly #bridge: EvalToolBridge | undefined;
    readonly #pythonBin: string;
    readonly #spawn: PythonSpawnFn;
    #child: PythonChildProcess | null = null;
    #reader: LineReader | null = null;
    #readyPromise: Promise<void> | null = null;
    #dead = false;

    constructor(options: EvalPythonKernelOptions = {}) {
        this.#bridge = options.bridge;
        this.#pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
        this.#spawn = options.spawn ?? defaultPythonSpawn;
    }

    async runCode(options: EvalPythonRunOptions): Promise<EvalRunResult> {
        if (this.#dead) {
            return failureResult('python kernel is dead; restarting on next call', ERROR_EXIT_CODE);
        }
        try {
            await this.#ensureReady();
        } catch (error) {
            this.#markDead();
            return failureResult(messageOf(error), ERROR_EXIT_CODE);
        }
        const child = this.#child;
        const reader = this.#reader;
        if (child === null || reader === null) {
            return failureResult('python kernel unavailable', ERROR_EXIT_CODE);
        }

        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const settled = await this.#driveRun(child, reader, options.code, timeoutMs, options.signal);
        if (settled === undefined) {
            this.#markDead();
            return failureResult('python kernel exited without a result', ERROR_EXIT_CODE);
        }
        return shapeResult(settled);
    }

    async reset(): Promise<void> {
        const child = this.#child;
        const reader = this.#reader;
        if (child === null || reader === null || this.#dead) {
            await this.#terminate();
            return;
        }
        try {
            child.stdin.write(lineFor({ type: 'reset' }));
            await this.#driveRun(child, reader, '', DEFAULT_TIMEOUT_MS, undefined);
        } catch {
            this.#markDead();
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
        if (this.#readyPromise === null) {
            throw new Error('failed to start python kernel');
        }
        await this.#readyPromise;
    }

    #spawnKernel(): void {
        const child = this.#spawn([this.#pythonBin, '-I', '-B', '-c', EVAL_PYTHON_RUNNER_SOURCE]);
        this.#child = child;
        const reader = createLineReader(child.stdout);
        this.#reader = reader;
        const { promise, resolve, reject } = createDeferred<void>();
        this.#readyPromise = promise;

        let resolvedReady = false;
        const readyTimer = setTimeout(() => {
            if (!resolvedReady) {
                this.#markDead();
                reject(new Error('python kernel init timed out'));
            }
        }, KERNEL_INIT_TIMEOUT_MS);

        child.once('error', (error) => {
            this.#markDead();
            if (!resolvedReady) {
                clearTimeout(readyTimer);
                reject(error);
            }
        });
        child.on('exit', (code) => {
            this.#markDead();
            if (!resolvedReady) {
                clearTimeout(readyTimer);
                reject(new Error(`python kernel exited before ready (code=${code})`));
            }
        });

        void (async (): Promise<void> => {
            const firstLine = await reader.readLine();
            if (firstLine !== null) {
                const parsed = safeJsonParse(firstLine);
                if (parsed !== undefined && parsed['type'] === 'ready') {
                    resolvedReady = true;
                    clearTimeout(readyTimer);
                    resolve();
                    return;
                }
            }
            if (!resolvedReady) {
                this.#markDead();
                clearTimeout(readyTimer);
                reject(new Error('python kernel did not signal ready'));
            }
        })().catch(() => {
            if (!resolvedReady) {
                this.#markDead();
                clearTimeout(readyTimer);
                reject(new Error('python kernel init failed'));
            }
        });
    }

    async #driveRun(
        child: PythonChildProcess,
        reader: LineReader,
        code: string,
        timeoutMs: number,
        signal: AbortSignal | undefined,
    ): Promise<ParsedResult | undefined> {
        child.stdin.write(lineFor({ type: 'run', code }));

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            this.#killChild();
        }, timeoutMs);

        let aborted = false;
        const onAbort = (): void => {
            aborted = true;
            this.#killChild();
        };
        if (signal !== undefined) {
            if (signal.aborted) {
                queueMicrotask(onAbort);
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }

        try {
            while (true) {
                const line = await reader.readLine();
                if (line === null) {
                    if (timedOut) {
                        return { ok: false, output: '', error: 'python kernel timed out' };
                    }
                    if (aborted) {
                        return { ok: false, output: '', error: 'Execution aborted' };
                    }
                    return undefined;
                }
                const parsed = safeJsonParse(line);
                if (parsed === undefined) {
                    continue;
                }
                const type = parsed['type'];
                if (type === 'tool-call') {
                    await this.#serviceToolCall(child, parsed);
                    continue;
                }
                if (type === 'result') {
                    const ok = parsed['ok'] === true;
                    const output = typeof parsed['output'] === 'string' ? (parsed['output'] as string) : '';
                    const error = typeof parsed['error'] === 'string' ? (parsed['error'] as string) : undefined;
                    return { ok, output, error };
                }
            }
        } finally {
            clearTimeout(timer);
            if (signal !== undefined) {
                signal.removeEventListener('abort', onAbort);
            }
        }
    }

    async #serviceToolCall(child: PythonChildProcess, parsed: Record<string, unknown>): Promise<void> {
        const name = typeof parsed['name'] === 'string' ? (parsed['name'] as string) : '';
        const args = parsed['args'];
        let reply: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };
        if (this.#bridge === undefined) {
            reply = { ok: false, error: `eval tool bridge unavailable for call: ${name}` };
        } else {
            try {
                const value = await this.#bridge.handleToolCall(name, args);
                reply = { ok: true, value };
            } catch (error) {
                reply = { ok: false, error: messageOf(error) };
            }
        }
        child.stdin.write(lineFor({ type: 'tool-reply', reply }));
    }

    #killChild(): void {
        try {
            this.#child?.kill('SIGKILL');
        } catch {
            // best-effort
        }
    }

    #markDead(): void {
        this.#dead = true;
    }

    async #terminate(): Promise<void> {
        this.#markDead();
        const child = this.#child;
        const reader = this.#reader;
        this.#child = null;
        this.#reader = null;
        this.#readyPromise = null;
        reader?.stop();
        if (child !== null) {
            try {
                child.stdin.end();
            } catch {
                // ignore
            }
            this.#killChild();
        }
    }
}

function defaultPythonSpawn(argv: readonly string[]): PythonChildProcess {
    const child = spawn(argv[0] ?? DEFAULT_PYTHON_BIN, argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return adaptPythonChild(child);
}

function adaptPythonChild(child: ChildProcess): PythonChildProcess {
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdin === null || stdout === null || stderr === null) {
        throw new Error('python kernel spawn missing a required stdio pipe');
    }
    return {
        stdin: {
            write: (chunk: string) => stdin.write(chunk),
            end: () => {
                stdin.end();
            },
        },
        stdout,
        stderr,
        kill: (signal) => {
            child.kill(signal);
        },
        on: (event, listener) => {
            child.on(event, listener);
        },
        once: (event, listener) => {
            child.once(event, listener);
        },
    };
}

function shapeResult(parsed: ParsedResult): EvalRunResult {
    let output = parsed.output;
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

function failureResult(message: string, exitCode: number): EvalRunResult {
    if (exitCode === TIMEOUT_EXIT_CODE) {
        return { output: '', exitCode, truncated: false, timedOut: true };
    }
    if (exitCode === ABORT_EXIT_CODE) {
        return { output: 'Execution aborted\n', exitCode, truncated: false, timedOut: false };
    }
    return { output: `${message}\n`, exitCode, truncated: false, timedOut: false };
}

function lineFor(message: Record<string, unknown>): string {
    return `${JSON.stringify(message)}\n`;
}

function safeJsonParse(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);
        if (typeof value === 'object' && value !== null) {
            return value as Record<string, unknown>;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
        throw new Error('python kernel deferred initialization failed');
    }
    return { promise, resolve: resolveFn, reject: rejectFn };
}
