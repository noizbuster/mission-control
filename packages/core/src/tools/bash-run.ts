import type {
    AgentEvent,
    CommandRunEventMetadata,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import {
    assertAllowedCommandPipeline,
    assertTrustedWorkspace,
    buildTrustedBashEnv,
    defaultBashEnvAllowlist,
    defaultBashRunTimeoutMs,
    resolveBashCwd,
} from './bash-run-policy.js';
import {
    type BashRunInput,
    type BashRunOutput,
    type BashRunToolOptions,
    bashRunInputSchema,
    bashRunParametersJsonSchema,
    commandRunModelOutput,
    commandRunOutputSchema,
    type ResolvedBashRunToolOptions,
} from './bash-run-schemas.js';
import { commandRunFailure } from './command-run-errors.js';
import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    executeCommand,
    executeCommandPipeline,
} from './command-run-executor.js';
import { interruptedBeforeSpawnResult } from './command-run-interruption.js';
import { buildPermissionPatterns } from './command-run-policy.js';
import { commandRunOutput } from './command-run-schemas.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { realpath } from 'node:fs/promises';

const defaultBashRunOutputBytes = 64 * 1024;
const defaultBashRunModelOutputChars = 8 * 1024;

export type { BashRunToolOptions };

export async function registerBashRunTool(
    registry: ToolRegistry,
    options: BashRunToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createBashRunToolRegistration(options));
}

export async function createBashRunToolRegistration(
    options: BashRunToolOptions,
): Promise<ToolRegistration<BashRunInput, BashRunOutput>> {
    const resolved = await resolveOptions(options);
    const limiter = new BashRunLimiter();
    return {
        name: 'bash.run',
        description: 'Run a trusted non-interactive bash command inside the workspace with strict safety caps.',
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: bashRunParametersJsonSchema(),
        inputSchema: bashRunInputSchema,
        outputSchema: commandRunOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runBashTool(resolved, limiter, input, context),
        toModelOutput: commandRunModelOutput,
        toEvents: bashRunEvents,
    };
}

async function resolveOptions(options: BashRunToolOptions): Promise<ResolvedBashRunToolOptions> {
    return {
        workspaceRoot: await realpath(options.workspaceRoot),
        workspaceTrust: options.workspaceTrust,
        requestPermission: options.requestPermission,
        executor: options.executor ?? executeCommand,
        pipelineExecutor: options.pipelineExecutor ?? executeCommandPipeline,
        timeoutMs: options.timeoutMs ?? defaultBashRunTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? defaultBashRunOutputBytes,
        maxModelOutputChars: options.maxModelOutputChars ?? defaultBashRunModelOutputChars,
        envAllowlist: [...(options.envAllowlist ?? defaultBashEnvAllowlist)],
        hostEnv: options.hostEnv ?? process.env,
    };
}

async function runBashTool(
    options: ResolvedBashRunToolOptions,
    limiter: BashRunLimiter,
    input: BashRunInput,
    context: ToolExecutionContext,
): Promise<BashRunOutput> {
    assertTrustedWorkspace(options.workspaceTrust);
    const segments = assertAllowedCommandPipeline(input.commandLine);
    const cwd = await resolveBashCwd(options.workspaceRoot, input.cwd);
    const { env, redactionSecrets } = buildTrustedBashEnv(options.hostEnv, options.envAllowlist);
    const release = limiter.acquire();
    const displayCommand = flattenSegmentsForDisplay(segments);
    const started = commandEvent(
        'command.started',
        context.toolCallId,
        commandMetadata(displayCommand, cwd, 'started'),
    );
    try {
        await requireApproval(options, context.toolCallId, input.commandLine, segments);
        if (context.signal.aborted) {
            return commandRunOutput(
                displayCommand,
                cwd,
                interruptedBeforeSpawnResult(),
                options.maxOutputBytes,
                redactionSecrets,
            );
        }
        const result = await runBashPipeline(options, segments, cwd, env, context.signal);
        const output = commandRunOutput(displayCommand, cwd, result, options.maxOutputBytes, redactionSecrets);
        if (output.timedOut) {
            throw commandRunFailure('command_timed_out', `command timed out: ${input.commandLine}`, [
                started,
                commandEvent('command.timed_out', context.toolCallId, metadataForOutput(output, 'timed_out')),
            ]);
        }
        if (output.status === 'failed') {
            throw commandRunFailure('command_failed', `command failed: ${input.commandLine}`, [
                started,
                commandEvent('command.failed', context.toolCallId, metadataForOutput(output, 'failed')),
            ]);
        }
        return output;
    } finally {
        release();
    }
}

/**
 * Build the single-argv display form for event metadata by joining segment argvs with a literal
 * `|` token. Backward compatible with the prior `readonly string[]` shape: a single-segment
 * command produces the unchanged argv, and a pipeline produces a human-readable `cat | grep`
 * display without changing the persisted `command` field shape.
 */
function flattenSegmentsForDisplay(segments: readonly (readonly string[])[]): readonly string[] {
    if (segments.length === 0) {
        return [];
    }
    if (segments.length === 1) {
        const [single] = segments;
        return single === undefined ? [] : [...single];
    }
    const flattened: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment === undefined) {
            continue;
        }
        if (index > 0) {
            flattened.push('|');
        }
        flattened.push(...segment);
    }
    return flattened;
}

async function runBashPipeline(
    options: ResolvedBashRunToolOptions,
    segments: readonly (readonly string[])[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
): Promise<CommandExecutionResult> {
    if (segments.length === 1) {
        const [single] = segments;
        return runBashCommand(options, single ?? [], cwd, env, signal);
    }
    return runBashCommandPipeline(options, segments, cwd, env, signal);
}

async function runBashCommand(
    options: ResolvedBashRunToolOptions,
    command: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
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
            cwd,
            env,
            signal: controller.signal,
            maxOutputBytes: options.maxOutputBytes,
        });
        timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, options.timeoutMs);
        const result = await execution;
        if (interrupted && !timedOut) {
            return { ...result, signal: result.signal ?? 'SIGTERM', timedOut: false };
        }
        return timedOut
            ? {
                  ...result,
                  signal: result.signal ?? 'SIGTERM',
                  timedOut: true,
                  durationMs: Math.max(result.durationMs, options.timeoutMs),
              }
            : result;
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
        throw commandRunFailure('command_spawn_failed', error instanceof Error ? error.message : String(error));
    } finally {
        signal.removeEventListener('abort', interrupt);
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

async function runBashCommandPipeline(
    options: ResolvedBashRunToolOptions,
    segments: readonly (readonly string[])[],
    cwd: string,
    env: NodeJS.ProcessEnv,
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
        const requests: CommandExecutionRequest[] = segments.map((segment) => ({
            command: segment[0] ?? '',
            args: segment.slice(1),
            cwd,
            env,
            signal: controller.signal,
            maxOutputBytes: options.maxOutputBytes,
        }));
        const execution = options.pipelineExecutor(requests);
        timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, options.timeoutMs);
        const result = await execution;
        if (interrupted && !timedOut) {
            return { ...result, signal: result.signal ?? 'SIGTERM', timedOut: false };
        }
        return timedOut
            ? {
                  ...result,
                  signal: result.signal ?? 'SIGTERM',
                  timedOut: true,
                  durationMs: Math.max(result.durationMs, options.timeoutMs),
              }
            : result;
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
        throw commandRunFailure('command_spawn_failed', error instanceof Error ? error.message : String(error));
    } finally {
        signal.removeEventListener('abort', interrupt);
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

async function requireApproval(
    options: ResolvedBashRunToolOptions,
    toolCallId: string,
    commandLine: string,
    segments: readonly (readonly string[])[],
): Promise<void> {
    const patterns = buildPipelinePermissionPatterns(commandLine, segments);
    const request: PermissionRequest = {
        ...permissionRequest({
            toolCallId,
            action: 'bash.run',
            reason: `run trusted bash: ${commandLine}`,
            permission: 'bash',
            patterns,
            workspaceRoot: options.workspaceRoot,
        }),
    };
    const decision = await requestToolPermission(options.requestPermission, request);
    if (decision.status === 'allow') {
        return;
    }
    throw commandRunFailure(errorCodeForDecision(decision), decision.reason ?? `approval refused: ${decision.status}`);
}

/**
 * Aggregate permission patterns across every segment of a pipeline. Each segment's argv
 * contributes its own command-line pattern and extracted file paths so an approval covers the
 * full pipeline (a per-segment approval would surprise the user mid-pipeline). Falls back to
 * the original command line when no segment contributes path patterns.
 */
function buildPipelinePermissionPatterns(
    commandLine: string,
    segments: readonly (readonly string[])[],
): readonly string[] {
    const patterns: string[] = [commandLine];
    for (const segment of segments) {
        const segmentLine = segment.join(' ');
        const segmentPatterns = buildPermissionPatterns(segmentLine, segment);
        for (const pattern of segmentPatterns) {
            if (pattern !== commandLine && !patterns.includes(pattern)) {
                patterns.push(pattern);
            }
        }
    }
    return patterns;
}

function bashRunEvents(output: BashRunOutput, context: { readonly toolCallId: string }): readonly AgentEvent[] {
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

function metadataForOutput(output: BashRunOutput, status: CommandRunEventMetadata['status']): CommandRunEventMetadata {
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

class BashRunLimiter {
    private running = false;

    acquire(): () => void {
        if (this.running) {
            throw commandRunFailure('concurrency_limit', 'another bash.run invocation is already running');
        }
        this.running = true;
        return () => {
            this.running = false;
        };
    }
}
