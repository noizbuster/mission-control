// Clean-room reimplementation of an interactive tmux-control tool. Origin:
// oh-my-openagent (Sustainable Use License) interactive_bash tool. The upstream
// is source-visible but not permissively licensed, so nothing here is copied
// from it; the tmux session-control pattern (tokenize a tmux subcommand, locate
// the subcommand past global options, refuse dangerous subcommands, spawn the
// tmux binary, cap and return its output) is reimplemented from scratch in
// mission-control's style and types. Attribution only.
//
// Config-gated: the factory returns null when the tmux binary is not on PATH,
// so the tool is simply not registered in that case. It reuses the shared
// spawn + output-cap executor from command-run-executor and the same approval
// and redaction seams as bash.run / shell.session.

import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { z } from 'zod';
import { redactCredentialText } from '../providers/credential-resolver';
import { commandRunFailure } from './command-run-errors';
import { type CommandExecutionResult, executeCommand } from './command-run-executor';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry';
import type { ToolExecutionContext } from './tool-registry-types';
import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';

const defaultInteractiveBashTimeoutMs = 60_000;
const defaultInteractiveBashOutputBytes = 64 * 1024;
const defaultInteractiveBashModelOutputChars = 8 * 1024;

/**
 * tmux subcommands that must never run because they tear down shared state
 * belonging to other sessions, the user, or sibling agents.
 */
const PROHIBITED_SUBCOMMANDS = new Set<string>(['kill-server']);

/**
 * tmux subcommands that are blocked because they belong to the one-shot Bash
 * tool surface (capture / save output), not interactive control. The tool
 * returns a hint instead of running them.
 */
const BLOCKED_SUBCOMMANDS = new Set<string>([
    'capture-pane',
    'capturep',
    'save-buffer',
    'saveb',
    'show-buffer',
    'showb',
    'pipe-pane',
    'pipep',
]);

/**
 * tmux global options that consume the following token as their argument, so
 * the subcommand search must skip two tokens when one of these appears.
 */
const TMUX_OPTIONS_WITH_ARG = new Set<string>(['-L', '-S', '-f', '-c', '-T']);

export const interactiveBashInputSchema = z
    .object({
        tmuxCommand: z
            .string()
            .min(1)
            .max(4_000)
            .describe("tmux subcommand to execute, WITHOUT the 'tmux' prefix (e.g. 'new-session -d -s dev')"),
    })
    .strict();
export type InteractiveBashInput = z.infer<typeof interactiveBashInputSchema>;

export const interactiveBashOutputSchema = z
    .object({
        kind: z.literal('interactive_bash'),
        tmuxCommand: z.string(),
        cwd: z.string().min(1),
        status: z.enum(['completed', 'failed', 'blocked', 'timed_out']),
        exitCode: z.number().int().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        blockedReason: z.string().nullable(),
        durationMs: z.number().nonnegative(),
    })
    .strict();
export type InteractiveBashOutput = z.infer<typeof interactiveBashOutputSchema>;

export type InteractiveBashExecutor = (request: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly maxOutputBytes: number;
}) => Promise<CommandExecutionResult>;

export type InteractiveBashToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly tmuxBinary?: string;
    readonly tmuxAvailable?: boolean;
    readonly executor?: InteractiveBashExecutor;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly maxModelOutputChars?: number;
};

type ResolvedInteractiveBashToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: InteractiveBashToolOptions['requestPermission'];
    readonly tmuxBinary: string;
    readonly executor: InteractiveBashExecutor;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxModelOutputChars: number;
};

/**
 * Returns true when a `tmux` binary is discoverable on PATH. Used to config-gate
 * tool registration. The optional override lets tests force either branch
 * deterministically without depending on the host.
 */
export function isTmuxAvailable(override?: boolean): boolean {
    if (override !== undefined) {
        return override;
    }
    try {
        const result = spawnSync('tmux', ['-V'], { shell: false, stdio: 'ignore' });
        return result.status === 0 || result.error === undefined;
    } catch {
        return false;
    }
}

/**
 * Register the interactive_bash tool. Returns null (and registers nothing) when
 * tmux is unavailable, so callers can skip it without branching.
 */
export async function registerInteractiveBashTool(
    registry: {
        register(registration: ToolRegistration<InteractiveBashInput, InteractiveBashOutput>): ToolAdvertisement;
    },
    options: InteractiveBashToolOptions,
): Promise<ToolAdvertisement | null> {
    const registration = await createInteractiveBashToolRegistration(options);
    if (registration === null) {
        return null;
    }
    return registry.register(registration);
}

export async function createInteractiveBashToolRegistration(
    options: InteractiveBashToolOptions,
): Promise<ToolRegistration<InteractiveBashInput, InteractiveBashOutput> | null> {
    if (!isTmuxAvailable(options.tmuxAvailable)) {
        return null;
    }
    const resolved = await resolveOptions(options);
    const limiter = new InteractiveBashLimiter();
    return {
        name: 'interactive_bash',
        description:
            'Run a tmux subcommand for interactive terminal sessions (create/attach/send-keys). Config-gated on tmux availability. Pass tmux subcommands WITHOUT the tmux prefix.',
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: interactiveBashParametersJsonSchema(),
        inputSchema: interactiveBashInputSchema,
        outputSchema: interactiveBashOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runInteractiveBash(resolved, limiter, input, context),
        toModelOutput: interactiveBashModelOutput,
        toEvents: interactiveBashEvents,
    };
}

function interactiveBashParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            tmuxCommand: {
                type: 'string',
                description: "tmux subcommand WITHOUT the 'tmux' prefix (e.g. 'new-session -d -s dev').",
            },
        },
        required: ['tmuxCommand'],
        additionalProperties: false,
    };
}

async function resolveOptions(options: InteractiveBashToolOptions): Promise<ResolvedInteractiveBashToolOptions> {
    return {
        workspaceRoot: await realpath(options.workspaceRoot),
        requestPermission: options.requestPermission,
        tmuxBinary: options.tmuxBinary ?? 'tmux',
        executor: options.executor ?? defaultExecutor(options.tmuxBinary ?? 'tmux'),
        timeoutMs: options.timeoutMs ?? defaultInteractiveBashTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? defaultInteractiveBashOutputBytes,
        maxModelOutputChars: options.maxModelOutputChars ?? defaultInteractiveBashModelOutputChars,
    };
}

function defaultExecutor(tmuxBinary: string): InteractiveBashExecutor {
    return (request) =>
        executeCommand({
            command: tmuxBinary,
            args: request.args,
            cwd: request.cwd,
            signal: request.signal,
            maxOutputBytes: request.maxOutputBytes,
        });
}

async function runInteractiveBash(
    options: ResolvedInteractiveBashToolOptions,
    limiter: InteractiveBashLimiter,
    input: InteractiveBashInput,
    context: ToolExecutionContext,
): Promise<InteractiveBashOutput> {
    const tokens = tokenizeTmuxCommand(input.tmuxCommand);
    if (tokens.length === 0) {
        throw commandRunFailure('command_not_allowed', 'empty tmux command is denied');
    }
    const subcommandIndex = findSubcommandIndex(tokens);
    const subcommand = subcommandIndex === -1 ? '' : (tokens[subcommandIndex] ?? '').toLowerCase();

    const prohibited = PROHIBITED_SUBCOMMANDS.has(subcommand);
    if (prohibited) {
        return blockedOutput(
            input.tmuxCommand,
            options.workspaceRoot,
            `'${subcommand}' is prohibited: it destroys shared tmux state. Use a scoped kill-session instead.`,
        );
    }
    const blocked = BLOCKED_SUBCOMMANDS.has(subcommand);
    if (blocked) {
        return blockedOutput(
            input.tmuxCommand,
            options.workspaceRoot,
            `'${subcommand}' is blocked in interactive_bash; use the Bash tool for one-shot capture instead.`,
        );
    }

    await requireApproval(options, context.toolCallId, input.tmuxCommand);
    const release = limiter.acquire();
    const started = Date.now();
    try {
        if (context.signal.aborted) {
            return completedOutput(input.tmuxCommand, options.workspaceRoot, {
                exitCode: null,
                stdout: '',
                stderr: '',
                timedOut: false,
                durationMs: 0,
            });
        }
        const result = await runWithTimeout(options, tokens, context.signal);
        return completedOutput(input.tmuxCommand, options.workspaceRoot, {
            ...result,
            durationMs: Date.now() - started,
        });
    } finally {
        release();
    }
}

async function runWithTimeout(
    options: ResolvedInteractiveBashToolOptions,
    tokens: readonly string[],
    signal: AbortSignal,
): Promise<CommandExecutionResult> {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const interrupt = (): void => controller.abort();
    if (signal.aborted) {
        interrupt();
    } else {
        signal.addEventListener('abort', interrupt, { once: true });
    }
    const timeoutPromise = new Promise<CommandExecutionResult>((resolve) => {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            controller.abort();
            resolve({
                exitCode: null,
                signal: 'SIGTERM',
                timedOut: true,
                stdout: '',
                stderr: '',
                durationMs: options.timeoutMs,
            });
        }, options.timeoutMs);
    });
    try {
        const execution = options.executor({
            args: tokens,
            cwd: options.workspaceRoot,
            signal: controller.signal,
            maxOutputBytes: options.maxOutputBytes,
        });
        const result = await Promise.race([execution, timeoutPromise]);
        return timedOut ? { ...result, timedOut: true } : result;
    } finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
        signal.removeEventListener('abort', interrupt);
    }
}

async function requireApproval(
    options: ResolvedInteractiveBashToolOptions,
    toolCallId: string,
    tmuxCommand: string,
): Promise<void> {
    const request: PermissionRequest = {
        ...permissionRequest({
            toolCallId,
            action: 'interactive_bash',
            reason: `run tmux subcommand: ${tmuxCommand}`,
            permission: 'bash',
            patterns: [tmuxCommand],
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

function completedOutput(
    tmuxCommand: string,
    cwd: string,
    result: {
        readonly exitCode: number | null;
        readonly stdout: string;
        readonly stderr: string;
        readonly timedOut: boolean;
        readonly durationMs: number;
    },
): InteractiveBashOutput {
    const redactedStdout = redactCredentialText(result.stdout, []);
    const redactedStderr = redactCredentialText(result.stderr, []);
    const status: InteractiveBashOutput['status'] = result.timedOut
        ? 'timed_out'
        : result.exitCode === 0
          ? 'completed'
          : 'failed';
    return {
        kind: 'interactive_bash',
        tmuxCommand: redactCredentialText(tmuxCommand, []),
        cwd,
        status,
        exitCode: result.exitCode,
        stdout: redactedStdout,
        stderr: redactedStderr,
        blockedReason: null,
        durationMs: result.durationMs,
    };
}

function blockedOutput(tmuxCommand: string, cwd: string, reason: string): InteractiveBashOutput {
    return {
        kind: 'interactive_bash',
        tmuxCommand,
        cwd,
        status: 'blocked',
        exitCode: null,
        stdout: '',
        stderr: '',
        blockedReason: reason,
        durationMs: 0,
    };
}

/**
 * Quote-aware tokenizer for a single tmux subcommand line. Handles single and
 * double quotes plus backslash escapes; treats unquoted whitespace as a
 * separator. Returns an empty list for blank input.
 */
export function tokenizeTmuxCommand(command: string): readonly string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (char === undefined) {
            continue;
        }
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote !== null) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (/\s/u.test(char)) {
            pushIfNonEmpty(tokens, current);
            current = '';
            continue;
        }
        current += char;
    }
    if (quote !== null) {
        throw commandRunFailure('command_not_allowed', 'unterminated quote in tmux command is denied');
    }
    if (escaped) {
        throw commandRunFailure('command_not_allowed', 'trailing escape in tmux command is denied');
    }
    pushIfNonEmpty(tokens, current);
    return tokens;
}

function pushIfNonEmpty(tokens: string[], token: string): void {
    if (token.length > 0) {
        tokens.push(token);
    }
}

/**
 * Locate the index of the tmux subcommand token, skipping global options that
 * take an argument (`-L socket`, `-S`, `-f`, `-c`, `-T`) and a leading `--`.
 * Returns -1 when no subcommand follows.
 */
export function findSubcommandIndex(tokens: readonly string[]): number {
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index] ?? '';
        if (token === '--') {
            return index + 1 < tokens.length ? index + 1 : -1;
        }
        if (TMUX_OPTIONS_WITH_ARG.has(token)) {
            index += 2;
            continue;
        }
        if (token.startsWith('-')) {
            index += 1;
            continue;
        }
        return index;
    }
    return -1;
}

function interactiveBashModelOutput(output: InteractiveBashOutput): string {
    if (output.status === 'blocked' && output.blockedReason !== null) {
        return `$ tmux ${output.tmuxCommand}\n${output.blockedReason}`;
    }
    const header = `$ tmux ${output.tmuxCommand}\nstatus: ${output.status}`;
    const body = output.stdout.length > 0 ? `\n${output.stdout}` : '';
    const errSuffix = output.stderr.length > 0 ? `\n[stderr]\n${output.stderr}` : '';
    return `${header}${body}${errSuffix}`;
}

function interactiveBashEvents(
    output: InteractiveBashOutput,
    context: { readonly toolCallId: string },
): readonly AgentEvent[] {
    const status = output.status === 'completed' ? 'completed' : 'failed';
    return [
        commandEvent('command.started', context.toolCallId, output.tmuxCommand, output.cwd, 'started'),
        commandEvent(`command.${status}`, context.toolCallId, output.tmuxCommand, output.cwd, status),
    ];
}

function commandEvent(
    type: 'command.started' | 'command.completed' | 'command.failed',
    toolCallId: string,
    tmuxCommand: string,
    cwd: string,
    status: 'started' | 'completed' | 'failed',
): AgentEvent {
    return {
        type,
        timestamp: new Date().toISOString(),
        taskId: toolCallId,
        message: `${status}: tmux ${tmuxCommand}`,
        nativeSidecarStatus: 'native',
        command: {
            command: ['tmux', tmuxCommand],
            cwd,
            status,
            exitCode: null,
            signal: null,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
        },
    };
}

class InteractiveBashLimiter {
    private running = false;

    acquire(): () => void {
        if (this.running) {
            throw commandRunFailure('concurrency_limit', 'another interactive_bash invocation is already running');
        }
        this.running = true;
        return () => {
            this.running = false;
        };
    }
}
