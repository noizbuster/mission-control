import type {
    AgentEvent,
    CommandRunEventMetadata,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import { commandRunFailure } from './command-run-errors.js';
import { executeCommand } from './command-run-executor.js';
import { interruptedBeforeSpawnResult, runCommandWithTimeout } from './command-run-interruption.js';
import { allowedCommand } from './command-run-policy.js';
import {
    type CommandRunInput,
    type CommandRunOutput,
    type CommandRunToolOptions,
    commandRunInputSchema,
    commandRunModelOutput,
    commandRunOutput,
    commandRunOutputSchema,
    commandRunParametersJsonSchema,
    type ResolvedCommandRunToolOptions,
} from './command-run-schemas.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { realpath } from 'node:fs/promises';

const defaultCommandRunTimeoutMs = 120_000;

export type { CommandExecutionRequest, CommandExecutionResult } from './command-run-executor.js';
export type { CommandRunToolOptions } from './command-run-schemas.js';

export async function registerCommandRunTool(
    registry: ToolRegistry,
    options: CommandRunToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createCommandRunToolRegistration(options));
}

export async function createCommandRunToolRegistration(
    options: CommandRunToolOptions,
): Promise<ToolRegistration<CommandRunInput, CommandRunOutput>> {
    const resolved = await resolveOptions(options);
    const limiter = new CommandRunLimiter();
    return {
        name: 'command.run',
        description: 'Run an approved non-interactive test or typecheck command in the workspace.',
        capabilityClasses: ['command.run'],
        parametersJsonSchema: commandRunParametersJsonSchema(),
        inputSchema: commandRunInputSchema,
        outputSchema: commandRunOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runCommandTool(resolved, limiter, input, context),
        toModelOutput: commandRunModelOutput,
        toEvents: commandRunEvents,
    };
}

async function resolveOptions(options: CommandRunToolOptions): Promise<ResolvedCommandRunToolOptions> {
    return {
        workspaceRoot: await realpath(options.workspaceRoot),
        requestPermission: options.requestPermission,
        executor: options.executor ?? executeCommand,
        timeoutMs: options.timeoutMs ?? defaultCommandRunTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
        maxModelOutputChars: options.maxModelOutputChars ?? 8 * 1024,
    };
}

async function runCommandTool(
    options: ResolvedCommandRunToolOptions,
    limiter: CommandRunLimiter,
    input: CommandRunInput,
    context: ToolExecutionContext,
): Promise<CommandRunOutput> {
    const command = allowedCommand(input.command, input.args);
    const release = limiter.acquire();
    const started = commandEvent(
        'command.started',
        context.toolCallId,
        commandMetadata(command, options.workspaceRoot, 'started'),
    );
    try {
        await requireApproval(options, context.toolCallId, command);
        if (context.signal.aborted) {
            return commandRunOutput(
                command,
                options.workspaceRoot,
                interruptedBeforeSpawnResult(),
                options.maxOutputBytes,
            );
        }
        const result = await runCommand(options, command, context.signal);
        const output = commandRunOutput(command, options.workspaceRoot, result, options.maxOutputBytes);
        if (output.timedOut) {
            throw commandRunFailure('command_timed_out', `command timed out: ${command.join(' ')}`, [
                started,
                commandEvent('command.timed_out', context.toolCallId, metadataForOutput(output, 'timed_out')),
            ]);
        }
        if (output.status === 'failed') {
            throw commandRunFailure('command_failed', commandFailedMessage(output), [
                started,
                commandEvent('command.failed', context.toolCallId, metadataForOutput(output, 'failed')),
            ]);
        }
        return output;
    } finally {
        release();
    }
}

async function runCommand(options: ResolvedCommandRunToolOptions, command: readonly string[], signal: AbortSignal) {
    try {
        return await runCommandWithTimeout(options, command, signal);
    } catch (error: unknown) {
        throw commandRunFailure('command_spawn_failed', error instanceof Error ? error.message : String(error));
    }
}

async function requireApproval(
    options: ResolvedCommandRunToolOptions,
    toolCallId: string,
    command: readonly string[],
): Promise<void> {
    const request: PermissionRequest = {
        id: `permission_${toolCallId}`,
        action: 'command.run',
        reason: `run command: ${command.join(' ')}`,
    };
    const decision = await options.requestPermission(request);
    if (decision.status === 'allow') {
        return;
    }
    throw commandRunFailure(errorCodeForDecision(decision), decision.reason ?? `approval refused: ${decision.status}`);
}

function commandRunEvents(output: CommandRunOutput, context: { readonly toolCallId: string }): readonly AgentEvent[] {
    const status = output.status === 'completed' ? 'completed' : 'failed';
    return [
        commandEvent('command.started', context.toolCallId, metadataForOutput(output, 'started')),
        commandEvent(`command.${status}`, context.toolCallId, metadataForOutput(output, status)),
    ];
}

function commandEvent(
    type: 'command.started' | 'command.completed' | 'command.failed' | 'command.timed_out',
    toolCallId: string,
    command: CommandRunEventMetadata,
): AgentEvent {
    return {
        type,
        timestamp: new Date().toISOString(),
        taskId: toolCallId,
        message: `${command.status}: ${command.command.join(' ')}`,
        nativeSidecarStatus: 'mock',
        command,
    };
}

function metadataForOutput(
    output: CommandRunOutput,
    status: CommandRunEventMetadata['status'],
): CommandRunEventMetadata {
    return {
        command: output.command,
        cwd: output.cwd,
        status,
        exitCode: output.exitCode,
        signal: output.signal,
        timedOut: output.timedOut,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
        durationMs: output.durationMs,
    };
}

function commandFailedMessage(output: CommandRunOutput): string {
    return `command failed: ${output.command.join(' ')} exit: ${output.exitCode ?? output.signal ?? 'unknown'}`;
}

function commandMetadata(
    command: readonly string[],
    cwd: string,
    status: CommandRunEventMetadata['status'],
): CommandRunEventMetadata {
    return { command: [...command], cwd, status };
}

function errorCodeForDecision(decision: PermissionDecision): 'approval_denied' | 'approval_required' {
    return decision.status === 'deny' ? 'approval_denied' : 'approval_required';
}

class CommandRunLimiter {
    private running = false;

    acquire(): () => void {
        if (this.running) {
            throw commandRunFailure('concurrency_limit', 'another command.run invocation is already running');
        }
        this.running = true;
        return () => {
            this.running = false;
        };
    }
}
