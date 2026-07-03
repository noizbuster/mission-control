/**
 * `ssh` tool (Task 19): one remote command against a configured host, run via a
 * pty so interactive prompts (sudo/password) surface in the output stream.
 *
 * Config-gated: the tool is only registered when at least one host is configured
 * (`createSshToolRegistration` returns `null` otherwise), so the model can never
 * discover a half-wired ssh surface. Hosts come from the `SshHostConfig` schema
 * in `@mission-control/protocol`. Ported from oh-my-pi's `ssh` tool (MIT),
 * rewritten to route through mission-control's sidecar v3 `pty.alloc` capability
 * (`PtySessionTransport` from task 17) instead of a direct portable-pty spawn.
 *
 * Containment parity with shell.session / bash.run: trust-gated (exec tier),
 * approval-required, 64KB cumulative output cap (enforced by `assemblePtyFrames`),
 * secret redaction over the accepted payload, and the host's `keyPath` is added
 * to the redaction set so it never echoes back through the model output.
 */
import type {
    PermissionDecision,
    PermissionRequest,
    SidecarStreamFrame,
    SshHostConfig,
} from '@mission-control/protocol';
import { z } from 'zod';
import { redactCredentialText } from '../providers/credential-resolver.js';
import { assertTrustedWorkspace } from './bash-run-policy.js';
import { commandRunFailure } from './command-run-errors.js';
import { assemblePtyFrames, type PtySessionTransport } from './pty-client.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { truncateOutput } from './truncate.js';
import { randomUUID } from 'node:crypto';

const SSH_TOOL_NAME = 'ssh';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MODEL_OUTPUT_CHARS = 8 * 1024;

const SSH_TOOL_DESCRIPTION =
    'Run a single command on a configured remote host over ssh via a pty (interactive prompts appear in the output). Hosts must be declared in config; pass the host name, not an address.';

const SSH_TOOL_GUIDELINE =
    'Use ssh for one-off remote commands against configured hosts. The command runs non-interactively over a pty; prefer key-based auth. Output is capped and redacted.';

export const sshInputSchema = z
    .object({
        host: z.string().min(1).max(128),
        command: z.string().min(1).max(8_000),
        cwd: z.string().min(1).max(1_024).optional(),
        timeout: z.number().int().positive().max(3_600).optional(),
    })
    .strict();
export type SshInput = z.infer<typeof sshInputSchema>;

export const sshOutputSchema = z
    .object({
        kind: z.literal('ssh'),
        host: z.string(),
        command: z.string(),
        remoteCommand: z.string(),
        status: z.enum(['completed', 'failed', 'timed_out']),
        exitCode: z.number().int().nullable(),
        output: z.string(),
        truncated: z.boolean(),
        originalBytes: z.number().int().nonnegative(),
        returnedBytes: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
        streamError: z.string().nullable(),
    })
    .strict();
export type SshOutput = z.infer<typeof sshOutputSchema>;

export type SshToolOptions = {
    readonly workspaceRoot: string;
    readonly workspaceTrust: 'trusted' | 'denied' | 'unknown';
    readonly hosts: readonly SshHostConfig[];
    readonly transport: PtySessionTransport;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly maxModelOutputChars?: number;
    readonly generateSessionId?: () => string;
};

type ResolvedSshToolOptions = {
    readonly workspaceRoot: string;
    readonly workspaceTrust: SshToolOptions['workspaceTrust'];
    readonly hostsByName: ReadonlyMap<string, SshHostConfig>;
    readonly transport: PtySessionTransport;
    readonly requestPermission: SshToolOptions['requestPermission'];
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxModelOutputChars: number;
    readonly generateSessionId: () => string;
};

export async function registerSshTool(
    registry: ToolRegistry,
    options: SshToolOptions,
): Promise<ToolAdvertisement | null> {
    const registration = createSshToolRegistration(options);
    if (registration === null) {
        return null;
    }
    return registry.register(registration);
}

export function createSshToolRegistration(options: SshToolOptions): ToolRegistration<SshInput, SshOutput> | null {
    if (options.hosts.length === 0) {
        return null;
    }
    const resolved = resolveOptions(options);
    return {
        name: SSH_TOOL_NAME,
        description: `${SSH_TOOL_DESCRIPTION}\n\nConfigured hosts: ${[...resolved.hostsByName.keys()].sort().join(', ')}`,
        capabilityClasses: ['bash.run', 'network'],
        parametersJsonSchema: sshParametersJsonSchema(),
        inputSchema: sshInputSchema,
        outputSchema: sshOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runSshTool(resolved, input, context),
        toModelOutput: sshModelOutput,
    };
}

function resolveOptions(options: SshToolOptions): ResolvedSshToolOptions {
    const hostsByName = new Map<string, SshHostConfig>();
    for (const host of options.hosts) {
        if (!hostsByName.has(host.name)) {
            hostsByName.set(host.name, host);
        }
    }
    return {
        workspaceRoot: options.workspaceRoot,
        workspaceTrust: options.workspaceTrust,
        hostsByName,
        transport: options.transport,
        requestPermission: options.requestPermission,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        maxModelOutputChars: options.maxModelOutputChars ?? DEFAULT_MODEL_OUTPUT_CHARS,
        generateSessionId: options.generateSessionId ?? (() => randomUUID()),
    };
}

function sshParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            host: { type: 'string', description: 'Configured host name (not an address).' },
            command: { type: 'string', description: 'Remote command to execute.' },
            cwd: { type: 'string', description: 'Optional remote working directory.' },
            timeout: { type: 'integer', description: 'Per-call timeout in seconds (default 30).' },
        },
        required: ['host', 'command'],
        additionalProperties: false,
    };
}

async function runSshTool(
    options: ResolvedSshToolOptions,
    input: SshInput,
    context: ToolExecutionContext,
): Promise<SshOutput> {
    assertTrustedWorkspace(options.workspaceTrust);
    const host = options.hostsByName.get(input.host);
    if (host === undefined) {
        const available = [...options.hostsByName.keys()].sort().join(', ');
        throw commandRunFailure(
            'command_failed',
            `ssh host "${input.host}" is not configured. Available: ${available}`,
        );
    }
    const remoteCommand = buildRemoteCommand(input.command, input.cwd);
    const sshCommand = buildSshCommand(host, remoteCommand);
    const sessionId = options.generateSessionId();
    const redactionSecrets = collectRedactionSecrets(host);

    await requireSshApproval(options, context.toolCallId, host.name, sshCommand);

    const timeoutMs = (input.timeout ?? options.timeoutMs / 1000) * 1000;
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => {
        controller.abort();
    };
    if (context.signal.aborted) {
        queueMicrotask(onAbort);
    } else {
        context.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    let frames: readonly SidecarStreamFrame[];
    try {
        frames = await options.transport.allocPty({
            sessionId,
            command: sshCommand,
            timeoutMs,
        });
    } catch (error) {
        clearTimeout(timeoutHandle);
        context.signal.removeEventListener('abort', onAbort);
        const message = error instanceof Error ? error.message : String(error);
        return sshOutput(host.name, input.command, remoteCommand, {
            exitCode: null,
            output: message,
            timedOut: false,
            streamError: 'transport_error',
            durationMs: Date.now() - started,
        });
    }
    clearTimeout(timeoutHandle);
    context.signal.removeEventListener('abort', onAbort);

    const assembled = assemblePtyFrames(frames, {
        maxBytes: options.maxOutputBytes,
        redactionSecrets,
    });
    const effectiveTimedOut = timedOut || assembled.timedOut;
    return sshOutput(host.name, input.command, remoteCommand, {
        exitCode: assembled.exitCode,
        output: assembled.output,
        timedOut: effectiveTimedOut,
        streamError: assembled.streamError,
        durationMs: Date.now() - started,
    });

    function sshOutput(
        hostName: string,
        command: string,
        remoteCommand: string,
        result: {
            readonly exitCode: number | null;
            readonly output: string;
            readonly timedOut: boolean;
            readonly streamError: string | null;
            readonly durationMs: number;
        },
    ): SshOutput {
        const capped = truncateOutput(result.output, options.maxOutputBytes);
        const originalBytes = Buffer.byteLength(result.output, 'utf8');
        const returnedBytes = Buffer.byteLength(capped.content, 'utf8');
        const status: SshOutput['status'] = result.timedOut
            ? 'timed_out'
            : result.streamError === null || result.exitCode === 0
              ? 'completed'
              : 'failed';
        return {
            kind: 'ssh',
            host: hostName,
            command: redactCredentialText(command, redactionSecrets),
            remoteCommand: redactCredentialText(remoteCommand, redactionSecrets),
            status,
            exitCode: result.exitCode,
            output: capped.content,
            truncated: capped.truncated || result.timedOut,
            originalBytes,
            returnedBytes,
            durationMs: result.durationMs,
            streamError: result.streamError,
        };
    }
}

function buildRemoteCommand(command: string, cwd: string | undefined): string {
    if (cwd === undefined || cwd.length === 0) {
        return command;
    }
    return `cd ${quoteSh(cwd)} && ${command}`;
}

function buildSshCommand(host: SshHostConfig, remoteCommand: string): string {
    const argv: string[] = ['ssh', '-o', 'StrictHostKeyChecking=accept-new'];
    if (host.port !== undefined) {
        argv.push('-p', String(host.port));
    }
    if (host.keyPath !== undefined) {
        argv.push('-i', quoteSh(host.keyPath));
    }
    const target =
        host.username !== undefined && host.username.length > 0 ? `${host.username}@${host.host}` : host.host;
    argv.push(target, quoteSh(remoteCommand));
    return argv.join(' ');
}

function quoteSh(value: string): string {
    if (value.length === 0) {
        return "''";
    }
    return `'${value.replace(/'/gu, "'\\''")}'`;
}

function collectRedactionSecrets(host: SshHostConfig): readonly string[] {
    const secrets: string[] = [];
    if (host.keyPath !== undefined && host.keyPath.length > 0) {
        secrets.push(host.keyPath);
    }
    return secrets;
}

async function requireSshApproval(
    options: ResolvedSshToolOptions,
    toolCallId: string,
    hostName: string,
    sshCommand: string,
): Promise<void> {
    const request: PermissionRequest = {
        ...permissionRequest({
            toolCallId,
            action: 'ssh',
            reason: `run ssh on host ${hostName}: ${sshCommand}`,
            permission: 'bash',
            patterns: [sshCommand],
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

function sshModelOutput(output: SshOutput): string {
    const header = `## ssh ${output.host}`;
    const body = output.output.endsWith('\n') ? output.output.slice(0, -1) : output.output;
    const lines: string[] = [header];
    if (body.length > 0) {
        lines.push(body);
    }
    if (output.exitCode !== null && output.exitCode !== 0) {
        lines.push(`[exit code: ${output.exitCode}]`);
    }
    if (output.truncated) {
        lines.push('[output truncated]');
    }
    return lines.join('\n');
}
