// Clean-room reimplementation of a background command monitor stop tool.
// Origin: upstream agent harness (Sustainable Use License) monitor_stop tool. Reimplemented
// from scratch in mission-control's types; nothing copied. Attribution only.
//
// Config-gated: returns null when `config.enabled === false`. A monitor may only be
// stopped by the session that owns it (parentSessionId match); cross-session stops
// return `denied` and unknown or terminal monitors return `already-stopped`.

import type { AgentEvent } from '@mission-control/protocol';
import { z } from 'zod';
import type { MonitorManager } from './monitor-manager';
import type { MonitorToolsConfig } from './monitor-start-tool';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry';
import type { ToolExecutionContext } from './tool-registry-types';

export const MONITOR_STOP_TOOL_NAME = 'monitor_stop';
const MONITOR_STOP_OUTPUT_LIMIT = { maxModelOutputChars: 1000 } as const;

export const monitorStopInputSchema = z
    .object({
        monitor_id: z.string().min(1).max(256),
    })
    .strict();
export type MonitorStopInput = z.infer<typeof monitorStopInputSchema>;

export const monitorStopOutputSchema = z
    .object({
        kind: z.literal('monitor_stop'),
        monitorId: z.string().min(1),
        status: z.enum(['stopped', 'already-stopped', 'denied']),
    })
    .strict();
export type MonitorStopOutput = z.infer<typeof monitorStopOutputSchema>;

export interface MonitorStopToolOptions {
    readonly manager: MonitorManager;
    readonly config: MonitorToolsConfig;
    readonly sessionId: string;
}

export async function createMonitorStopToolRegistration(
    options: MonitorStopToolOptions,
): Promise<ToolRegistration<MonitorStopInput, MonitorStopOutput> | null> {
    if (!options.config.enabled) {
        return null;
    }
    const resolved: MonitorStopToolOptions = {
        manager: options.manager,
        config: options.config,
        sessionId: options.sessionId,
    };
    return {
        name: MONITOR_STOP_TOOL_NAME,
        description:
            'Stop a running monitor owned by the current session. Unknown or already-terminal monitors return already-stopped; monitors owned by a different session return denied.',
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: monitorStopParametersJsonSchema(),
        inputSchema: monitorStopInputSchema,
        outputSchema: monitorStopOutputSchema,
        outputLimit: MONITOR_STOP_OUTPUT_LIMIT,
        execute: (input) => runMonitorStop(resolved, input),
        toModelOutput: monitorStopModelOutput,
        toEvents: monitorStopEvents,
    };
}

export async function registerMonitorStopTool(
    registry: { register(registration: ToolRegistration<MonitorStopInput, MonitorStopOutput>): ToolAdvertisement },
    options: MonitorStopToolOptions,
): Promise<ToolAdvertisement | null> {
    const registration = await createMonitorStopToolRegistration(options);
    if (registration === null) {
        return null;
    }
    return registry.register(registration);
}

function monitorStopParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            monitor_id: {
                type: 'string',
                description: 'Monitor ID returned by monitor_start.',
            },
        },
        required: ['monitor_id'],
        additionalProperties: false,
    };
}

async function runMonitorStop(options: MonitorStopToolOptions, input: MonitorStopInput): Promise<MonitorStopOutput> {
    const record = options.manager.get(input.monitor_id);
    if (record === undefined) {
        return { kind: 'monitor_stop', monitorId: input.monitor_id, status: 'already-stopped' };
    }
    if (record.parentSessionId !== options.sessionId) {
        return { kind: 'monitor_stop', monitorId: input.monitor_id, status: 'denied' };
    }
    if (record.status === 'stopped' || record.status === 'exited' || record.status === 'failed') {
        return { kind: 'monitor_stop', monitorId: input.monitor_id, status: 'already-stopped' };
    }
    await options.manager.stop(input.monitor_id);
    return { kind: 'monitor_stop', monitorId: input.monitor_id, status: 'stopped' };
}

function monitorStopModelOutput(output: MonitorStopOutput): string {
    return JSON.stringify({
        status: output.status,
        monitor_id: output.monitorId,
    });
}

function monitorStopEvents(output: MonitorStopOutput, context: { readonly toolCallId: string }): readonly AgentEvent[] {
    if (output.status !== 'stopped') {
        return [];
    }
    return [
        {
            type: 'command.completed',
            timestamp: new Date().toISOString(),
            taskId: context.toolCallId,
            message: `monitor stopped: ${output.monitorId}`,
            nativeSidecarStatus: 'native',
            command: {
                command: [MONITOR_STOP_TOOL_NAME, output.monitorId],
                cwd: '',
                status: 'completed',
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                durationMs: 0,
            },
        },
    ];
}

// Re-exported so callers can import the config + name cluster from one place.
export { DEFAULT_MONITOR_TOOLS_CONFIG, type MonitorToolsConfig } from './monitor-start-tool';
export type { ToolExecutionContext };
