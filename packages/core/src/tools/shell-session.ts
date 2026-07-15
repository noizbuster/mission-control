import type {
    AgentEvent,
    CommandRunEventMetadata,
    PermissionDecision,
    PermissionRequest,
    SidecarStreamFrame,
} from '@mission-control/protocol';
import { z } from 'zod';
import { redactCredentialText } from '../providers/credential-resolver';
import { truncateToValidUtf8Boundary } from '../providers/stream-decoder';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation';
import {
    assertTrustedWorkspace,
    buildTrustedBashEnv,
    defaultBashEnvAllowlist,
    defaultBashRunTimeoutMs,
    resolveBashCwd,
} from './bash-run-policy';
import { commandOperatorAborted, commandRunFailure } from './command-run-errors';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry';
import type { ToolExecutionContext } from './tool-registry-types';
import { type TruncatedOutput, truncateOutput, withContinuationHint } from './truncate';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

const defaultShellSessionOutputBytes = 64 * 1024;
const defaultShellSessionModelOutputChars = 8 * 1024;

export const shellSessionInputSchema = z
    .object({
        commandLine: z.string().min(1).max(8_000),
        cwd: z.string().min(1).max(1_024).optional(),
        sessionId: z.string().min(1).max(256).optional(),
    })
    .strict();
export type ShellSessionInput = z.infer<typeof shellSessionInputSchema>;

export const shellSessionOutputSchema = z
    .object({
        kind: z.literal('shell_session'),
        sessionId: z.string().min(1),
        commandLine: z.string(),
        cwd: z.string(),
        status: z.enum(['completed', 'failed', 'timed_out']),
        exitCode: z.number().int().nullable(),
        stdout: z.string(),
        truncated: z.boolean(),
        originalBytes: z.number().int().nonnegative(),
        returnedBytes: z.number().int().nonnegative(),
        durationMs: z.number().nonnegative(),
        streamError: z.string().nullable(),
    })
    .strict();
export type ShellSessionOutput = z.infer<typeof shellSessionOutputSchema>;

/**
 * Transport seam that delivers a shell command to the sidecar v3 shell.session
 * capability and returns the emitted `SidecarStreamFrame`s (seq strictly
 * increasing, final frame carries end:true). The real implementation adapts
 * `ProcessSidecarClient`; tests inject an in-memory stateful mock.
 */
export interface ShellSessionTransport {
    openSession(request: ShellSessionTransportRequest): Promise<readonly SidecarStreamFrame[]>;
}

export interface ShellSessionTransportRequest {
    readonly sessionId: string;
    readonly command: string;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly signal: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
}

export type ShellSessionToolOptions = {
    readonly workspaceRoot: string;
    readonly workspaceTrust: 'trusted' | 'denied' | 'unknown';
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly transport: ShellSessionTransport;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly maxModelOutputChars?: number;
    readonly envAllowlist?: readonly string[];
    readonly hostEnv?: NodeJS.ProcessEnv;
    readonly generateSessionId?: () => string;
};

type ResolvedShellSessionToolOptions = {
    readonly workspaceRoot: string;
    readonly workspaceTrust: ShellSessionToolOptions['workspaceTrust'];
    readonly requestPermission: ShellSessionToolOptions['requestPermission'];
    readonly transport: ShellSessionTransport;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxModelOutputChars: number;
    readonly envAllowlist: readonly string[];
    readonly hostEnv: NodeJS.ProcessEnv;
    readonly generateSessionId: () => string;
};

export async function registerShellSessionTool(
    registry: ToolRegistry,
    options: ShellSessionToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createShellSessionToolRegistration(options));
}

export async function createShellSessionToolRegistration(
    options: ShellSessionToolOptions,
): Promise<ToolRegistration<ShellSessionInput, ShellSessionOutput>> {
    const resolved = await resolveOptions(options);
    const limiter = new ShellSessionLimiter();
    return {
        name: 'shell.session',
        description:
            'Run a stateful bash command inside a persistent sidecar v3 shell session with the same containment as bash.run (30s timeout, 64KB cap, cwd gate, secret redaction).',
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: shellSessionParametersJsonSchema(),
        inputSchema: shellSessionInputSchema,
        outputSchema: shellSessionOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runShellSessionTool(resolved, limiter, input, context),
        toModelOutput: shellSessionModelOutput,
        toEvents: shellSessionEvents,
    };
}

function shellSessionParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            commandLine: {
                type: 'string',
                description: 'Bash command executed inside a persistent sidecar shell session.',
            },
            cwd: {
                type: 'string',
                description: 'Optional workspace-relative or absolute descendant directory for the command cwd.',
            },
            sessionId: {
                type: 'string',
                description: 'Optional stable session id; omit to start a fresh isolated session.',
            },
        },
        required: ['commandLine'],
        additionalProperties: false,
    };
}

async function resolveOptions(options: ShellSessionToolOptions): Promise<ResolvedShellSessionToolOptions> {
    return {
        workspaceRoot: await realpath(options.workspaceRoot),
        workspaceTrust: options.workspaceTrust,
        requestPermission: options.requestPermission,
        transport: options.transport,
        timeoutMs: options.timeoutMs ?? defaultBashRunTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? defaultShellSessionOutputBytes,
        maxModelOutputChars: options.maxModelOutputChars ?? defaultShellSessionModelOutputChars,
        envAllowlist: [...(options.envAllowlist ?? defaultBashEnvAllowlist)],
        hostEnv: options.hostEnv ?? process.env,
        generateSessionId: options.generateSessionId ?? (() => randomUUID()),
    };
}

async function runShellSessionTool(
    options: ResolvedShellSessionToolOptions,
    limiter: ShellSessionLimiter,
    input: ShellSessionInput,
    context: ToolExecutionContext,
): Promise<ShellSessionOutput> {
    assertTrustedWorkspace(options.workspaceTrust);
    const cwd = await resolveBashCwd(options.workspaceRoot, input.cwd);
    const { env, redactionSecrets } = buildTrustedBashEnv(options.hostEnv, options.envAllowlist);
    const sessionId = input.sessionId ?? options.generateSessionId();
    const release = limiter.acquire(sessionId);
    const started = commandEvent('command.started', context.toolCallId, {
        command: ['shell.session', input.commandLine],
        cwd,
        status: 'started',
    });
    try {
        await requireShellSessionApproval(options, context.toolCallId, input.commandLine);
        if (context.signal.aborted) {
            const output = shellSessionOutput(
                sessionId,
                input.commandLine,
                cwd,
                { exitCode: null, output: '', timedOut: false, streamError: 'aborted_before_spawn', durationMs: 0 },
                options.maxOutputBytes,
                redactionSecrets,
            );
            throw commandOperatorAborted(`shell.session interrupted before spawn: ${input.commandLine}`, [
                started,
                commandEvent('command.failed', context.toolCallId, metadataForOutput(output, 'failed')),
            ]);
        }
        const result = await runShellSessionCommand(
            options,
            sessionId,
            input.commandLine,
            cwd,
            env,
            context.signal,
            context.controlEpoch,
        );
        const output = shellSessionOutput(
            sessionId,
            input.commandLine,
            cwd,
            result,
            options.maxOutputBytes,
            redactionSecrets,
        );
        if (result.timedOut) {
            throw commandRunFailure('command_timed_out', `shell.session timed out: ${input.commandLine}`, [
                started,
                commandEvent('command.timed_out', context.toolCallId, metadataForOutput(output, 'timed_out')),
            ]);
        }
        if (output.status === 'failed') {
            if (context.signal.aborted) {
                throw commandOperatorAborted(`shell.session interrupted: ${input.commandLine}`, [
                    started,
                    commandEvent('command.failed', context.toolCallId, metadataForOutput(output, 'failed')),
                ]);
            }
            throw commandRunFailure('command_failed', `shell.session failed: ${input.commandLine}`, [
                started,
                commandEvent('command.failed', context.toolCallId, metadataForOutput(output, 'failed')),
            ]);
        }
        return output;
    } finally {
        release();
    }
}

type RawRunResult = {
    readonly exitCode: number | null;
    readonly output: string;
    readonly timedOut: boolean;
    readonly streamError: string | null;
    readonly durationMs: number;
};

async function runShellSessionCommand(
    options: ResolvedShellSessionToolOptions,
    sessionId: string,
    commandLine: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    controlEpoch?: SessionControlEpoch,
): Promise<RawRunResult> {
    const controller = new AbortController();
    let timedOut = false;
    let interrupted = false;
    const startedAt = Date.now();
    const interrupt = (): void => {
        interrupted = true;
        controller.abort();
    };
    if (signal.aborted) {
        interrupt();
    } else {
        signal.addEventListener('abort', interrupt, { once: true });
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<RawRunResult>((resolve) => {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            controller.abort();
            resolve({
                exitCode: null,
                output: '',
                timedOut: true,
                streamError: null,
                durationMs: options.timeoutMs,
            });
        }, options.timeoutMs);
    });
    try {
        const transportEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) {
            if (typeof value === 'string') {
                transportEnv[key] = value;
            }
        }
        const transportPromise = options.transport
            .openSession({
                sessionId,
                command: commandLine,
                cwd,
                ...(Object.keys(transportEnv).length > 0 ? { env: transportEnv } : {}),
                timeoutMs: options.timeoutMs,
                signal: controller.signal,
                ...(controlEpoch !== undefined ? { controlEpoch } : {}),
            })
            .then((frames): RawRunResult => assembleFrames(frames, Date.now() - startedAt));
        const outcome = await Promise.race([transportPromise, timeoutPromise]);
        if (interrupted && !timedOut) {
            return { ...outcome, streamError: outcome.streamError ?? 'interrupted' };
        }
        return outcome;
    } finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
        signal.removeEventListener('abort', interrupt);
    }
}

function assembleFrames(frames: readonly SidecarStreamFrame[], elapsedMs: number): RawRunResult {
    let payload = '';
    let streamError: string | null = null;
    for (const frame of frames) {
        if (frame.payload.length > 0) {
            payload = `${payload}${frame.payload}`;
        }
        if (frame.error !== undefined && streamError === null) {
            streamError = frame.error;
        }
    }
    const exitCode = parseExitCode(streamError);
    const timedOut = streamError === 'timed_out';
    return {
        exitCode,
        output: payload,
        timedOut,
        streamError,
        durationMs: elapsedMs,
    };
}

function parseExitCode(streamError: string | null): number | null {
    if (streamError === null) {
        return 0;
    }
    const match = /^nonzero_exit:(-?\d+)$/u.exec(streamError);
    if (match === null) {
        return null;
    }
    const parsed = Number.parseInt(match[1] ?? '', 10);
    return Number.isNaN(parsed) ? null : parsed;
}

async function requireShellSessionApproval(
    options: ResolvedShellSessionToolOptions,
    toolCallId: string,
    commandLine: string,
): Promise<void> {
    const request: PermissionRequest = {
        ...permissionRequest({
            toolCallId,
            action: 'shell.session',
            reason: `run shell.session: ${commandLine}`,
            permission: 'bash',
            patterns: [commandLine],
            workspaceRoot: options.workspaceRoot,
        }),
    };
    const decision = await requestToolPermission(options.requestPermission, request);
    if (decision.status === 'allow') {
        return;
    }
    throw commandRunFailure(
        decision.status === 'deny' ? 'approval_denied' : 'approval_required',
        decision.reason ?? `approval refused: ${decision.status}`,
    );
}

function shellSessionOutput(
    sessionId: string,
    commandLine: string,
    cwd: string,
    result: RawRunResult,
    maxOutputBytes: number,
    redactionSecrets: readonly string[],
): ShellSessionOutput {
    const redacted = redactCredentialText(result.output, redactionSecrets);
    const capped = capText(redacted, maxOutputBytes);
    const status: ShellSessionOutput['status'] = result.timedOut
        ? 'timed_out'
        : result.streamError === null || result.exitCode === 0
          ? 'completed'
          : 'failed';
    return {
        kind: 'shell_session',
        sessionId,
        commandLine: redactCredentialText(commandLine, redactionSecrets),
        cwd,
        status,
        exitCode: result.exitCode,
        stdout: capped.text,
        truncated: capped.truncated,
        originalBytes: capped.originalBytes,
        returnedBytes: capped.returnedBytes,
        durationMs: result.durationMs,
        streamError: result.streamError,
    };
}

type CappedText = {
    readonly text: string;
    readonly truncated: boolean;
    readonly originalBytes: number;
    readonly returnedBytes: number;
};

function capText(text: string, maxBytes: number): CappedText {
    const bytes = Buffer.from(text, 'utf8');
    const capped = bytes.length > maxBytes ? truncateToValidUtf8Boundary(bytes, maxBytes) : bytes;
    return {
        text: capped.toString('utf8'),
        truncated: bytes.length > capped.length,
        originalBytes: bytes.length,
        returnedBytes: capped.length,
    };
}

export function shellSessionModelOutput(output: ShellSessionOutput): string {
    const header = `$ ${output.commandLine} (session ${output.sessionId})\nstatus: ${output.status}`;
    const body = output.stdout.length > 0 ? `\n${output.stdout}` : '';
    const suffix =
        output.streamError !== null && output.exitCode !== 0 ? `\n[stream error: ${output.streamError}]` : '';
    const capped: TruncatedOutput = {
        content: body,
        truncated: output.truncated,
        originalLength: output.originalBytes,
        limit: 0,
    };
    const hint = withContinuationHint(
        capped,
        `output truncated at ${output.returnedBytes}/${output.originalBytes} bytes; rerun shell.session to continue`,
    );
    return `${header}${hint}${suffix}`;
}

function shellSessionEvents(
    output: ShellSessionOutput,
    context: { readonly toolCallId: string },
): readonly AgentEvent[] {
    const status: CommandRunEventMetadata['status'] = output.status === 'completed' ? 'completed' : 'failed';
    return [
        commandEvent('command.started', context.toolCallId, metadataForOutput(output, 'started')),
        commandEvent(`command.${status}`, context.toolCallId, metadataForOutput(output, status)),
    ];
}

function metadataForOutput(
    output: ShellSessionOutput,
    status: CommandRunEventMetadata['status'],
): CommandRunEventMetadata {
    return {
        command: ['shell.session', output.commandLine],
        cwd: output.cwd,
        status,
        exitCode: output.exitCode,
        signal: null,
        timedOut: output.status === 'timed_out',
        stdoutTruncated: output.truncated,
        stderrTruncated: false,
        durationMs: output.durationMs,
    };
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
        nativeSidecarStatus: 'native',
        command,
    };
}

class ShellSessionLimiter {
    private readonly active = new Map<string, true>();

    acquire(sessionId: string): () => void {
        if (this.active.has(sessionId)) {
            throw commandRunFailure(
                'concurrency_limit',
                `another shell.session invocation is already running for session ${sessionId}`,
            );
        }
        this.active.set(sessionId, true);
        return () => {
            this.active.delete(sessionId);
        };
    }
}

// Re-export for callers that want the truncation helper shape used by model output.
export { truncateOutput };
