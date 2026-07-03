// Clean-room reimplementation of a background command monitor start tool.
// Origin: oh-my-openagent (Sustainable Use License) monitor_start tool. Reimplemented
// from scratch in mission-control's types; nothing copied. Attribution only.
//
// Config-gated: `createMonitorStartToolRegistration` returns null when
// `config.enabled === false`, so the tool is simply not registered. It reuses the
// same containment seams as `shell.session` / `bash.run`: trusted-workspace
// assertion, bash permission request, env allowlist + secret redaction. Output
// never echoes the raw command back to the model; only the safe label is returned.

import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { z } from 'zod';
import { redactCredentialText } from '../providers/credential-resolver.js';
import { assertTrustedWorkspace, buildTrustedBashEnv, defaultBashEnvAllowlist } from './bash-run-policy.js';
import { commandRunFailure } from './command-run-errors.js';
import type { MonitorManager, MonitorMode } from './monitor-manager.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { realpath } from 'node:fs/promises';

export const MONITOR_START_TOOL_NAME = 'monitor_start';
const MONITOR_START_OUTPUT_LIMIT = { maxModelOutputChars: 2000 } as const;

export interface MonitorToolsConfig {
    readonly enabled: boolean;
    readonly liveModeEnabled: boolean;
    readonly maxMonitorsPerSession: number;
    readonly maxRuntimeMs: number;
}

export const DEFAULT_MONITOR_TOOLS_CONFIG: MonitorToolsConfig = {
    enabled: false,
    liveModeEnabled: false,
    maxMonitorsPerSession: 3,
    maxRuntimeMs: 1_800_000,
};

export const monitorStartInputSchema = z
    .object({
        command: z.string().min(1).max(8_000),
        label: z.string().min(1).max(256).optional(),
        mode: z.enum(['idle', 'live_safe']).optional(),
        match_pattern: z.string().max(2048).optional(),
    })
    .strict();
export type MonitorStartInput = z.infer<typeof monitorStartInputSchema>;

export const monitorStartOutputSchema = z
    .object({
        kind: z.literal('monitor_start'),
        monitorId: z.string().min(1),
        label: z.string(),
        mode: z.enum(['idle', 'live_safe']),
        denied: z.boolean(),
        note: z.string().nullable(),
    })
    .strict();
export type MonitorStartOutput = z.infer<typeof monitorStartOutputSchema>;

export interface MonitorStartToolOptions {
    readonly manager: MonitorManager;
    readonly config: MonitorToolsConfig;
    readonly workspaceRoot: string;
    readonly workspaceTrust: 'trusted' | 'denied' | 'unknown';
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly sessionId: string;
    readonly messageId?: string;
    readonly hostEnv?: NodeJS.ProcessEnv;
    readonly envAllowlist?: readonly string[];
}

type ResolvedStartOptions = {
    readonly manager: MonitorManager;
    readonly config: MonitorToolsConfig;
    readonly workspaceRoot: string;
    readonly workspaceTrust: MonitorStartToolOptions['workspaceTrust'];
    readonly requestPermission: MonitorStartToolOptions['requestPermission'];
    readonly sessionId: string;
    readonly messageId?: string;
    readonly hostEnv: NodeJS.ProcessEnv;
    readonly envAllowlist: readonly string[];
};

export async function createMonitorStartToolRegistration(
    options: MonitorStartToolOptions,
): Promise<ToolRegistration<MonitorStartInput, MonitorStartOutput> | null> {
    if (!options.config.enabled) {
        return null;
    }
    const resolved = await resolveStartOptions(options);
    return {
        name: MONITOR_START_TOOL_NAME,
        description:
            'Start a non-interactive background monitor command. Output is retained and delivered automatically on idle or pattern match; use the safe label, not the raw command, in transcripts. Config-gated on monitor.enabled.',
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: monitorStartParametersJsonSchema(),
        inputSchema: monitorStartInputSchema,
        outputSchema: monitorStartOutputSchema,
        outputLimit: MONITOR_START_OUTPUT_LIMIT,
        execute: (input, context) => runMonitorStart(resolved, input, context),
        toModelOutput: monitorStartModelOutput,
        toEvents: monitorStartEvents,
    };
}

export async function registerMonitorStartTool(
    registry: { register(registration: ToolRegistration<MonitorStartInput, MonitorStartOutput>): ToolAdvertisement },
    options: MonitorStartToolOptions,
): Promise<ToolAdvertisement | null> {
    const registration = await createMonitorStartToolRegistration(options);
    if (registration === null) {
        return null;
    }
    return registry.register(registration);
}

function monitorStartParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command to run in the background monitor.',
            },
            label: {
                type: 'string',
                description: 'Safe human-facing label for the monitor (never the raw command in transcripts).',
            },
            mode: {
                type: 'string',
                enum: ['idle', 'live_safe'],
                description: 'Delivery mode. idle is the safe default; live_safe requires monitor.live_mode_enabled.',
            },
            match_pattern: {
                type: 'string',
                description: 'Optional JavaScript regex. Matching lines are tagged for prioritized delivery.',
            },
        },
        required: ['command'],
        additionalProperties: false,
    };
}

async function resolveStartOptions(options: MonitorStartToolOptions): Promise<ResolvedStartOptions> {
    return {
        manager: options.manager,
        config: options.config,
        workspaceRoot: await realpath(options.workspaceRoot),
        workspaceTrust: options.workspaceTrust,
        requestPermission: options.requestPermission,
        sessionId: options.sessionId,
        ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
        hostEnv: options.hostEnv ?? process.env,
        envAllowlist: [...(options.envAllowlist ?? defaultBashEnvAllowlist)],
    };
}

async function runMonitorStart(
    options: ResolvedStartOptions,
    input: MonitorStartInput,
    context: ToolExecutionContext,
): Promise<MonitorStartOutput> {
    assertTrustedWorkspace(options.workspaceTrust);
    await requireApproval(options, context.toolCallId, input.command);

    const { env, redactionSecrets } = buildTrustedBashEnv(options.hostEnv, options.envAllowlist);
    const effectiveMode = resolveEffectiveMode(input.mode, options.config.liveModeEnabled);

    try {
        const record = await options.manager.start({
            command: input.command,
            cwd: options.workspaceRoot,
            env,
            ...(input.label !== undefined ? { label: input.label } : {}),
            mode: effectiveMode.mode,
            ...(input.match_pattern !== undefined ? { matchPattern: input.match_pattern } : {}),
            parentSessionId: options.sessionId,
            ...(options.messageId !== undefined ? { parentMessageId: options.messageId } : {}),
            redactionSecrets,
            maxRuntimeMs: options.config.maxRuntimeMs,
        });
        return {
            kind: 'monitor_start',
            monitorId: record.id,
            label: record.label,
            mode: record.mode,
            denied: false,
            note: effectiveMode.note ?? null,
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw commandRunFailure('command_failed', `monitor_start failed: ${message}`);
    }
}

type EffectiveMode = { readonly mode: MonitorMode; readonly note?: string };

function resolveEffectiveMode(requested: MonitorMode | undefined, liveModeEnabled: boolean): EffectiveMode {
    if (requested === 'live_safe' && !liveModeEnabled) {
        return {
            mode: 'idle',
            note: 'requested mode "live_safe" was coerced to "idle" because monitor.live_mode_enabled is false',
        };
    }
    return { mode: requested ?? 'idle' };
}

async function requireApproval(options: ResolvedStartOptions, toolCallId: string, command: string): Promise<void> {
    const request: PermissionRequest = {
        ...permissionRequest({
            toolCallId,
            action: MONITOR_START_TOOL_NAME,
            reason: `run monitor command: ${command}`,
            permission: 'bash',
            patterns: [command],
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

function monitorStartModelOutput(output: MonitorStartOutput): string {
    if (output.denied) {
        return `Monitor start denied.`;
    }
    const note = output.note !== null ? `\nnote: ${output.note}` : '';
    return [
        'Monitor started successfully.',
        '',
        `monitor_id: ${output.monitorId}`,
        `label: ${output.label}`,
        `mode: ${output.mode}${note}`,
        '',
        `To stop this monitor, call monitor_stop with monitor_id="${output.monitorId}".`,
        '',
        'Output arrives automatically on idle or pattern match; do not poll.',
    ].join('\n');
}

function monitorStartEvents(
    output: MonitorStartOutput,
    context: { readonly toolCallId: string },
): readonly AgentEvent[] {
    if (output.denied) {
        return [];
    }
    return [
        {
            type: 'command.started',
            timestamp: new Date().toISOString(),
            taskId: context.toolCallId,
            message: `monitor started: ${redactCredentialText(output.label, [])}`,
            nativeSidecarStatus: 'native',
            command: {
                command: [MONITOR_START_TOOL_NAME, output.monitorId],
                cwd: '',
                status: 'started',
                exitCode: null,
                signal: null,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                durationMs: 0,
            },
        },
    ];
}
