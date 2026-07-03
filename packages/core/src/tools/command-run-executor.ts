import type { ChainOperator } from './bash-run-command-guard.js';
import { type ChildProcess, spawn } from 'node:child_process';

const forceColorEnvKey = 'FORCE_COLOR';

export type CommandExecutionRequest = {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly maxOutputBytes: number;
    readonly env?: NodeJS.ProcessEnv;
};

export type CommandExecutionResult = {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutOriginalBytes?: number;
    readonly stderrOriginalBytes?: number;
    readonly stdoutTruncated?: boolean;
    readonly stderrTruncated?: boolean;
    readonly durationMs: number;
};

export function executeCommand(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(request.command, request.args, {
            cwd: request.cwd,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: request.env ?? nonInteractiveEnv(),
        });
        const stdout = createOutputCollector(request.maxOutputBytes);
        const stderr = createOutputCollector(request.maxOutputBytes);
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;

        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', reject);
        child.on('close', (exitCode, signal) => {
            if (killTimer !== undefined) {
                clearTimeout(killTimer);
            }
            resolve({
                exitCode,
                signal,
                timedOut,
                stdout: stdout.text(),
                stderr: stderr.text(),
                stdoutOriginalBytes: stdout.originalBytes(),
                stderrOriginalBytes: stderr.originalBytes(),
                stdoutTruncated: stdout.truncated(),
                stderrTruncated: stderr.truncated(),
                durationMs: Date.now() - startedAt,
            });
        });
        request.signal.addEventListener(
            'abort',
            () => {
                timedOut = true;
                child.kill('SIGTERM');
                killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
            },
            { once: true },
        );
    });
}

/**
 * Execute a pipeline of commands, piping each command's stdout into the next command's stdin.
 * The first command's stdin is `ignore` (no inherited stdin); only the LAST command's stdout is
 * captured. stderr is captured from every command and concatenated. The pipeline's exit code is
 * the LAST command's exit code (bash's default non-`pipefail` behavior): `cat missing | grep x`
 * resolves `0` even though cat failed.
 *
 * Security: each segment is spawned with `shell: false` (no shell interpretation). Same env,
 * cwd, signal, and output caps as `executeCommand`. An upstream child closing sends EOF to the
 * downstream stdin so a failing upstream does not hang a downstream reader.
 */
export function executeCommandPipeline(requests: readonly CommandExecutionRequest[]): Promise<CommandExecutionResult> {
    if (requests.length === 0) {
        throw new Error('executeCommandPipeline requires at least one request');
    }
    if (requests.length === 1) {
        const [single] = requests;
        if (single === undefined) {
            throw new Error('executeCommandPipeline received an undefined single request');
        }
        return executeCommand(single);
    }
    const startedAt = Date.now();
    const maxBytes = requests[0]?.maxOutputBytes ?? 64 * 1024;
    const signal = requests[0]?.signal ?? new AbortController().signal;
    return new Promise((resolve, reject) => {
        const children: ChildProcess[] = [];
        const stdout = createOutputCollector(maxBytes);
        const stderr = createOutputCollector(maxBytes);
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        let finalExitCode: number | null = null;
        let finalSignal: string | null = null;
        let settled = 0;

        const cleanup = () => {
            if (killTimer !== undefined) {
                clearTimeout(killTimer);
            }
        };

        const tryResolve = () => {
            if (settled === children.length) {
                cleanup();
                resolve({
                    exitCode: finalExitCode,
                    signal: finalSignal,
                    timedOut,
                    stdout: stdout.text(),
                    stderr: stderr.text(),
                    stdoutOriginalBytes: stdout.originalBytes(),
                    stderrOriginalBytes: stderr.originalBytes(),
                    stdoutTruncated: stdout.truncated(),
                    stderrTruncated: stderr.truncated(),
                    durationMs: Date.now() - startedAt,
                });
            }
        };

        try {
            for (let index = 0; index < requests.length; index += 1) {
                const request = requests[index];
                if (request === undefined) {
                    throw new Error(`executeCommandPipeline missing request at index ${index}`);
                }
                const isFirst = index === 0;
                const isLast = index === requests.length - 1;
                const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] = [isFirst ? 'ignore' : 'pipe', 'pipe', 'pipe'];
                const child = spawn(request.command, request.args, {
                    cwd: request.cwd,
                    shell: false,
                    stdio,
                    env: request.env ?? nonInteractiveEnv(),
                });
                children.push(child);
                if (!isLast) {
                    child.stdout?.on('data', (chunk: Buffer) => {
                        const next = children[index + 1];
                        next?.stdin?.write(chunk);
                    });
                    child.stdout?.on('end', () => {
                        const next = children[index + 1];
                        next?.stdin?.end();
                    });
                    child.stdout?.on('error', () => {
                        const next = children[index + 1];
                        next?.stdin?.destroy();
                    });
                } else {
                    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
                }
                child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
                child.on('error', (error) => {
                    cleanup();
                    for (const c of children) {
                        if (!c.killed) {
                            c.kill('SIGKILL');
                        }
                    }
                    reject(error);
                });
                child.on('close', (exitCode, exitSignal) => {
                    if (isLast) {
                        finalExitCode = exitCode;
                        finalSignal = exitSignal;
                    }
                    if (!isLast) {
                        const next = children[index + 1];
                        next?.stdin?.end();
                    }
                    settled += 1;
                    tryResolve();
                });
            }
        } catch (error) {
            cleanup();
            for (const c of children) {
                if (!c.killed) {
                    c.kill('SIGKILL');
                }
            }
            reject(error);
            return;
        }

        signal.addEventListener(
            'abort',
            () => {
                timedOut = true;
                for (const c of children) {
                    if (!c.killed) {
                        c.kill('SIGTERM');
                    }
                }
                killTimer = setTimeout(() => {
                    for (const c of children) {
                        if (!c.killed) {
                            c.kill('SIGKILL');
                        }
                    }
                }, 1000);
            },
            { once: true },
        );
    });
}

function createOutputCollector(maxBytes: number) {
    let totalBytes = 0;
    let kept = Buffer.alloc(0);
    return {
        push(chunk: Buffer) {
            totalBytes += chunk.length;
            if (kept.length >= maxBytes) {
                return;
            }
            kept = Buffer.concat([kept, chunk.subarray(0, maxBytes - kept.length)]);
        },
        text() {
            return kept.toString('utf8');
        },
        originalBytes() {
            return totalBytes;
        },
        truncated() {
            return totalBytes > kept.length;
        },
    };
}

/**
 * One chain step: a pipeline plus the operator that connected it to the PREVIOUS step. The
 * operator on `steps[0]` is ignored (entry pipeline always runs). Each subsequent step runs
 * only when its operator allows it given the previous step's exit code:
 * `&&` requires previous exit === 0, `||` requires previous exit !== 0, `;` always runs.
 */
export type CommandChainStep = {
    readonly pipeline: readonly CommandExecutionRequest[];
    readonly operator: ChainOperator;
};

/**
 * Execute a chain of pipelines connected by `&&`/`||`/`;`. Each pipeline runs via
 * {@linkcode executeCommandPipeline} (direct spawns, stdio piping, no shell). Stdout and stderr
 * across executed pipelines concatenate (so `git status; git diff` shows both). The chain's
 * exit code is the LAST-EXECUTED pipeline's exit code. The chain short-circuits left-to-right:
 * once an operator's condition fails, later steps do not run (bash parity).
 *
 * Timeout/abort propagation: if any step's result has `timedOut: true`, the chain stops and the
 * aggregated result also reports `timedOut: true`. Per-step aborts are owned by
 * {@linkcode executeCommandPipeline} (which honors each request's `signal`); the chain itself
 * does not race a separate timer. The caller ({@linkcode bash-run.ts}) wraps the chain in its
 * own timeout+abort controller so a single budget covers the whole chain.
 */
export async function executeCommandChain(steps: readonly CommandChainStep[]): Promise<CommandExecutionResult> {
    if (steps.length === 0) {
        throw new Error('executeCommandChain requires at least one step');
    }
    const first = steps[0];
    if (first === undefined) {
        throw new Error('executeCommandChain received an undefined first step');
    }
    if (steps.length === 1) {
        return executeCommandPipeline(first.pipeline);
    }
    const startedAt = Date.now();
    const maxBytes = first.pipeline[0]?.maxOutputBytes ?? 64 * 1024;
    const stdout = createOutputCollector(maxBytes);
    const stderr = createOutputCollector(maxBytes);
    let stdoutOriginalBytes = 0;
    let stderrOriginalBytes = 0;
    let lastExitCode: number | null = null;
    let lastSignal: string | null = null;
    let timedOut = false;

    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (step === undefined) {
            break;
        }
        if (index > 0) {
            const operator = step.operator;
            if (operator === '&&' && lastExitCode !== 0) {
                break;
            }
            if (operator === '||' && lastExitCode === 0) {
                break;
            }
        }
        const result = await executeCommandPipeline(step.pipeline);
        if (result.stdout.length > 0) {
            stdout.push(Buffer.from(result.stdout));
        }
        if (result.stderr.length > 0) {
            stderr.push(Buffer.from(result.stderr));
        }
        stdoutOriginalBytes += result.stdoutOriginalBytes ?? result.stdout.length;
        stderrOriginalBytes += result.stderrOriginalBytes ?? result.stderr.length;
        lastExitCode = result.exitCode;
        lastSignal = result.signal;
        if (result.timedOut) {
            timedOut = true;
            break;
        }
    }

    return {
        exitCode: lastExitCode,
        signal: lastSignal,
        timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutOriginalBytes,
        stderrOriginalBytes,
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        durationMs: Date.now() - startedAt,
    };
}

function nonInteractiveEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' };
    delete env[forceColorEnvKey];
    return env;
}
