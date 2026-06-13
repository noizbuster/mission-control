import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { z } from 'zod';
import type { CommandExecutionRequest, CommandExecutionResult } from './command-run-executor.js';
import { type CommandRunOutput, commandRunModelOutput, commandRunOutputSchema } from './command-run-schemas.js';

export const bashRunInputSchema = z
    .object({
        commandLine: z.string().min(1).max(4_000),
        cwd: z.string().min(1).max(1_024).optional(),
    })
    .strict();
export type BashRunInput = z.infer<typeof bashRunInputSchema>;

export type BashRunOutput = CommandRunOutput;

export type BashRunToolOptions = {
    readonly workspaceRoot: string;
    readonly workspaceTrust: 'trusted' | 'denied' | 'unknown';
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly executor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly maxModelOutputChars?: number;
    readonly envAllowlist?: readonly string[];
    readonly hostEnv?: NodeJS.ProcessEnv;
};

export type ResolvedBashRunToolOptions = {
    readonly workspaceRoot: string;
    readonly workspaceTrust: BashRunToolOptions['workspaceTrust'];
    readonly requestPermission: BashRunToolOptions['requestPermission'];
    readonly executor: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxModelOutputChars: number;
    readonly envAllowlist: readonly string[];
    readonly hostEnv: NodeJS.ProcessEnv;
};

export { commandRunModelOutput, commandRunOutputSchema };

export function bashRunParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            commandLine: {
                type: 'string',
                description: 'Trusted bash command line executed inside the workspace with strict safety caps.',
            },
            cwd: {
                type: 'string',
                description: 'Optional workspace-relative or absolute descendant directory for the command cwd.',
            },
        },
        required: ['commandLine'],
        additionalProperties: false,
    };
}
