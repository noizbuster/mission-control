import { spawn, type ChildProcess } from 'node:child_process';

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
export function executeCommandPipeline(
    requests: readonly CommandExecutionRequest[],
): Promise<CommandExecutionResult> {
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

function nonInteractiveEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' };
    delete env[forceColorEnvKey];
    return env;
}
