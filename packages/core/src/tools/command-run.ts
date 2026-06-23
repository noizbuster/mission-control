import type {
    AgentEvent,
    CommandRunEventMetadata,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import { commandRunFailure } from './command-run-errors.js';
import { executeCommand } from './command-run-executor.js';
import { interruptedBeforeSpawnResult, runCommandWithTimeout } from './command-run-interruption.js';
import { defaultCommandRunPolicyProfile, isAllowlistedCommand } from './command-run-policy.js';
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
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
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
        description: 'Run a command. Safe commands (pwd, whoami, hostname) run without asking. All other commands prompt the user for approval (Allow once / Always allow / Deny).',
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
        policyProfile: options.policyProfile ?? defaultCommandRunPolicyProfile,
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
    const command: readonly string[] = [input.command, ...input.args];
    const release = limiter.acquire();
    const started = commandEvent(
        'command.started',
        context.toolCallId,
        commandMetadata(command, options.workspaceRoot, 'started'),
    );
    try {
        if (!isAllowlistedCommand(input.command, input.args, options.policyProfile)) {
            await requireApproval(options, context.toolCallId, command);
        }
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
            throw commandRunFailure(
                'command_failed',
                commandFailedMessage(output, options.maxModelOutputChars),
                [started, commandEvent('command.failed', context.toolCallId, metadataForOutput(output, 'failed'))],
            );
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
        ...permissionRequest({
            toolCallId,
            action: 'command.run',
            reason: `run command: ${command.join(' ')}`,
            permission: 'bash',
            patterns: [command.join(' ')],
            workspaceRoot: options.workspaceRoot,
        }),
    };
    const decision = await requestToolPermission(options.requestPermission, request);
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

// The captured stdout/stderr MUST be surfaced (bounded) on a non-zero exit: a nonzero exit is
// often an informative result the model must read to recover (linter = "issues found", test runner
// = failure report). Discarding it leaves the model blind and it loops the same failing command
// until the graph retry budget runs out. Streams are already capped/redacted by commandRunOutput;
// each is further bounded to half of maxModelOutputChars here.
function commandFailedMessage(output: CommandRunOutput, maxModelOutputChars: number): string {
    const header = `command failed: ${output.command.join(' ')} exit: ${output.exitCode ?? output.signal ?? 'unknown'}`;
    const perStream = Math.max(256, Math.floor(maxModelOutputChars / 2));
    const stdout = boundedStream('stdout', output.stdout, perStream, output.stdoutTruncated);
    const stderr = boundedStream('stderr', output.stderr, perStream, output.stderrTruncated);
    return `${header}${stdout}${stderr}`;
}

function boundedStream(label: string, text: string, maxChars: number, streamTruncated: boolean): string {
    if (text.length === 0) {
        return '';
    }
    const slice = text.slice(0, maxChars);
    const note = streamTruncated || text.length > maxChars ? ` [truncated ${slice.length}/${text.length}]` : '';
    return `\n${label}:${note}\n${slice}`;
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
