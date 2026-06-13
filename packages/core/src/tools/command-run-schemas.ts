import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { z } from 'zod';
import { redactCredentialText } from '../providers/credential-resolver.js';
import type { CommandExecutionRequest, CommandExecutionResult } from './command-run-executor.js';
import type { CommandRunPolicyProfile } from './command-run-policy.js';

export const commandRunInputSchema = z
    .object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
    })
    .strict();
export type CommandRunInput = z.infer<typeof commandRunInputSchema>;

export const commandRunOutputSchema = z
    .object({
        kind: z.literal('command_run'),
        status: z.enum(['completed', 'failed']),
        command: z.array(z.string().min(1)).min(1),
        cwd: z.string().min(1),
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        timedOut: z.boolean(),
        stdout: z.string(),
        stderr: z.string(),
        stdoutTruncated: z.boolean(),
        stderrTruncated: z.boolean(),
        stdoutOriginalBytes: z.number().int().nonnegative(),
        stderrOriginalBytes: z.number().int().nonnegative(),
        stdoutReturnedBytes: z.number().int().nonnegative(),
        stderrReturnedBytes: z.number().int().nonnegative(),
        durationMs: z.number().nonnegative(),
    })
    .strict();
export type CommandRunOutput = z.infer<typeof commandRunOutputSchema>;

export type CommandRunToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly executor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly policyProfile?: CommandRunPolicyProfile;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly maxModelOutputChars?: number;
};

export type ResolvedCommandRunToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: CommandRunToolOptions['requestPermission'];
    readonly executor: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly policyProfile: CommandRunPolicyProfile;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxModelOutputChars: number;
};

export function commandRunParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Executable name from the command allowlist.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Structured argv, never a shell string.' },
        },
        required: ['command'],
        additionalProperties: false,
    };
}

export function commandRunModelOutput(output: CommandRunOutput): string {
    const header = `$ ${output.command.join(' ')}\nstatus: ${output.status} exit: ${output.exitCode ?? output.signal}`;
    const stdout = output.stdout.length > 0 ? `\nstdout:\n${output.stdout}` : '';
    const stderr = output.stderr.length > 0 ? `\nstderr:\n${output.stderr}` : '';
    const suffix =
        output.stdoutTruncated || output.stderrTruncated
            ? `\n[truncated stdout=${output.stdoutReturnedBytes}/${output.stdoutOriginalBytes} stderr=${output.stderrReturnedBytes}/${output.stderrOriginalBytes}]`
            : '';
    return `${header}${stdout}${stderr}${suffix}`;
}

export function commandRunOutput(
    command: readonly string[],
    cwd: string,
    result: CommandExecutionResult,
    maxOutputBytes: number,
    redactionSecrets: readonly string[] = [],
): CommandRunOutput {
    const stdout = capText(
        redactCredentialText(result.stdout, redactionSecrets),
        maxOutputBytes,
        result.stdoutOriginalBytes,
        result.stdoutTruncated,
    );
    const stderr = capText(
        redactCredentialText(result.stderr, redactionSecrets),
        maxOutputBytes,
        result.stderrOriginalBytes,
        result.stderrTruncated,
    );
    return {
        kind: 'command_run',
        status: result.exitCode === 0 && !result.timedOut ? 'completed' : 'failed',
        command: command.map((part) => redactCredentialText(part, redactionSecrets)),
        cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutOriginalBytes: stdout.originalBytes,
        stderrOriginalBytes: stderr.originalBytes,
        stdoutReturnedBytes: stdout.returnedBytes,
        stderrReturnedBytes: stderr.returnedBytes,
        durationMs: result.durationMs,
    };
}

function capText(text: string, maxBytes: number, originalBytesInput?: number, truncatedInput?: boolean) {
    const bytes = Buffer.from(text, 'utf8');
    const capped = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
    const originalBytes = originalBytesInput ?? bytes.length;
    return {
        text: capped.toString('utf8'),
        originalBytes,
        returnedBytes: capped.length,
        truncated: truncatedInput === true || originalBytes > capped.length,
    };
}
