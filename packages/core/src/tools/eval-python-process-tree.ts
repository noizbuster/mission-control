import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

const DEFAULT_PYTHON_BIN = 'python3';

export interface PythonChildProcess {
    readonly pid: number | undefined;
    readonly stdin: { write(chunk: string): boolean; end(): void };
    readonly stdout: NodeJS.ReadableStream;
    readonly stderr: NodeJS.ReadableStream;
    kill(signal?: NodeJS.Signals): void;
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    once(event: 'error', listener: (error: Error) => void): void;
    off(
        event: 'exit' | 'error',
        listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
    ): void;
}

export type PythonSpawnFn = (argv: readonly string[]) => PythonChildProcess;

export type PythonSpawnOptions = {
    readonly detached: boolean;
    readonly shell: false;
    readonly stdio: 'pipe';
    readonly windowsHide: true;
};

export type ProcessTreeCommandOptions = {
    readonly shell: false;
    readonly windowsHide: true;
    readonly stdio: 'ignore';
};

export type ProcessTreeCommandResult = {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
};

export type ProcessTreeCommandRunFn = (
    command: string,
    args: readonly string[],
    options: ProcessTreeCommandOptions,
) => Promise<ProcessTreeCommandResult>;

export type ProcessKillFn = (pid: number, signal: NodeJS.Signals) => void;
export type PythonProcessTreeTerminateFn = (pid: number | undefined) => Promise<void>;

export type PythonProcessTreeTerminatorOptions = {
    readonly platform?: NodeJS.Platform;
    readonly kill?: ProcessKillFn;
    readonly runCommand?: ProcessTreeCommandRunFn;
};

export type PythonProcessTreeTerminationReason = 'posix_kill_failed' | 'windows_taskkill_failed';

export class PythonProcessTreeTerminationError extends Error {
    readonly name = 'PythonProcessTreeTerminationError';

    constructor(
        readonly reason: PythonProcessTreeTerminationReason,
        readonly pid: number,
        detail: string,
        options?: ErrorOptions,
    ) {
        super(`failed to terminate python process tree ${String(pid)}: ${detail}`, options);
    }
}

export function pythonSpawnOptionsFor(platform: NodeJS.Platform): PythonSpawnOptions {
    return {
        detached: platform !== 'win32',
        shell: false,
        stdio: 'pipe',
        windowsHide: true,
    };
}

export const defaultPythonSpawn: PythonSpawnFn = (argv) => {
    const child = spawn(argv[0] ?? DEFAULT_PYTHON_BIN, argv.slice(1), pythonSpawnOptionsFor(process.platform));
    return adaptPythonChild(child);
};

export function createPythonProcessTreeTerminator(
    options: PythonProcessTreeTerminatorOptions = {},
): PythonProcessTreeTerminateFn {
    const platform = options.platform ?? process.platform;
    const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    const runCommand = options.runCommand ?? runProcessTreeCommand;

    return async (pid) => {
        if (pid === undefined) {
            return;
        }
        if (platform === 'win32') {
            let result: ProcessTreeCommandResult;
            try {
                result = await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
                    shell: false,
                    windowsHide: true,
                    stdio: 'ignore',
                });
            } catch (error) {
                throw new PythonProcessTreeTerminationError('windows_taskkill_failed', pid, messageOf(error), {
                    cause: error,
                });
            }
            if (result.exitCode !== 0) {
                const detail = `taskkill exited with code ${String(result.exitCode)} and signal ${String(result.signal)}`;
                throw new PythonProcessTreeTerminationError('windows_taskkill_failed', pid, detail);
            }
            return;
        }
        try {
            kill(-pid, 'SIGKILL');
        } catch (error) {
            if (isEsrch(error)) {
                return;
            }
            throw new PythonProcessTreeTerminationError('posix_kill_failed', pid, messageOf(error), { cause: error });
        }
    };
}

function adaptPythonChild(child: ChildProcessWithoutNullStreams): PythonChildProcess {
    return {
        pid: child.pid,
        stdin: {
            write: (chunk) => child.stdin.write(chunk),
            end: () => child.stdin.end(),
        },
        stdout: child.stdout,
        stderr: child.stderr,
        kill: (signal) => {
            child.kill(signal);
        },
        on: (event, listener) => {
            child.on(event, listener);
        },
        once: (event, listener) => {
            child.once(event, listener);
        },
        off: (event, listener) => {
            child.off(event, listener);
        },
    };
}

async function runProcessTreeCommand(
    command: string,
    args: readonly string[],
    options: ProcessTreeCommandOptions,
): Promise<ProcessTreeCommandResult> {
    return await new Promise<ProcessTreeCommandResult>((resolve, reject) => {
        const child = spawn(command, Array.from(args), options);
        const onError = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const onExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
            cleanup();
            resolve({ exitCode, signal });
        };
        const cleanup = (): void => {
            child.off('error', onError);
            child.off('exit', onExit);
        };
        child.once('error', onError);
        child.once('exit', onExit);
    });
}

function isEsrch(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
