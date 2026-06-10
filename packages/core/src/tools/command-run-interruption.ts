import type { CommandExecutionResult } from './command-run-executor.js';
import type { ResolvedCommandRunToolOptions } from './command-run-schemas.js';

export async function runCommandWithTimeout(
    options: ResolvedCommandRunToolOptions,
    command: readonly string[],
    signal: AbortSignal,
): Promise<CommandExecutionResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let interrupted = false;
    const startedAt = Date.now();
    const interrupt = () => {
        interrupted = true;
        controller.abort();
    };
    if (signal.aborted) {
        interrupt();
    } else {
        signal.addEventListener('abort', interrupt, { once: true });
    }
    try {
        const execution = options.executor({
            command: command[0] ?? '',
            args: command.slice(1),
            cwd: options.workspaceRoot,
            signal: controller.signal,
            maxOutputBytes: options.maxOutputBytes,
        });
        timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, options.timeoutMs);
        const result = await execution;
        if (interrupted && !timedOut) {
            return interruptedResult(result);
        }
        return timedOut ? timeoutResult(result, options.timeoutMs) : result;
    } catch (error: unknown) {
        if (timedOut) {
            return {
                exitCode: null,
                signal: 'SIGTERM',
                timedOut: true,
                stdout: '',
                stderr: '',
                durationMs: options.timeoutMs,
            };
        }
        if (interrupted) {
            return interruptedBeforeSpawnResult(Date.now() - startedAt);
        }
        throw error;
    } finally {
        signal.removeEventListener('abort', interrupt);
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

export function interruptedBeforeSpawnResult(durationMs = 0): CommandExecutionResult {
    return {
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: false,
        stdout: '',
        stderr: '',
        durationMs,
    };
}

function interruptedResult(result: CommandExecutionResult): CommandExecutionResult {
    return {
        ...result,
        signal: result.signal ?? 'SIGTERM',
        timedOut: false,
    };
}

function timeoutResult(result: CommandExecutionResult, timeoutMs: number): CommandExecutionResult {
    return {
        ...result,
        signal: result.signal ?? 'SIGTERM',
        timedOut: true,
        durationMs: Math.max(result.durationMs, timeoutMs),
    };
}
