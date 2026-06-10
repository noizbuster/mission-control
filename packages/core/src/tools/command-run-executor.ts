import { spawn } from 'node:child_process';

const forceColorEnvKey = 'FORCE_COLOR';

export type CommandExecutionRequest = {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly maxOutputBytes: number;
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
            env: nonInteractiveEnv(),
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
