// Clean-room reimplementation of a background command monitor list tool.
// Origin: upstream agent harness (Sustainable Use License) monitor_list tool. Reimplemented
// from scratch in mission-control's types; nothing copied. Attribution only.
//
// Config-gated: returns null when `config.enabled === false`. Lists monitors owned by
// the current session only, with id/label/mode/startedAt/status/counters. Raw commands
// are never included. Terminal monitors are hidden by default; pass include_exited to
// surface them.

import { z } from 'zod';
import type { MonitorCounters, MonitorManager, MonitorMode, MonitorStatus } from './monitor-manager';
import type { MonitorToolsConfig } from './monitor-start-tool';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry';

export const MONITOR_LIST_TOOL_NAME = 'monitor_list';
const MONITOR_LIST_OUTPUT_LIMIT = { maxModelOutputChars: 4000 } as const;

const HIDDEN_STATUSES: ReadonlySet<MonitorStatus> = new Set(['exited', 'stopped', 'failed']);

export const monitorListInputSchema = z
    .object({
        include_exited: z.boolean().optional(),
    })
    .strict();
export type MonitorListInput = z.infer<typeof monitorListInputSchema>;

const monitorCountersSchema = z
    .object({
        totalLines: z.number().int().nonnegative(),
        matchedLines: z.number().int().nonnegative(),
        unmatchedLines: z.number().int().nonnegative(),
        droppedMatched: z.number().int().nonnegative(),
        droppedUnmatched: z.number().int().nonnegative(),
        bytesDropped: z.number().int().nonnegative(),
        lastSequence: z.number().int().nonnegative(),
    })
    .strict();

const monitorEntrySchema = z
    .object({
        id: z.string().min(1),
        label: z.string(),
        mode: z.enum(['idle', 'live_safe']),
        startedAt: z.string(),
        status: z.enum(['starting', 'running', 'exited', 'stopped', 'failed']),
        counters: monitorCountersSchema,
    })
    .strict();

export const monitorListOutputSchema = z
    .object({
        kind: z.literal('monitor_list'),
        monitors: z.array(monitorEntrySchema),
    })
    .strict();
export type MonitorListOutput = z.infer<typeof monitorListOutputSchema>;

export interface MonitorListToolOptions {
    readonly manager: MonitorManager;
    readonly config: MonitorToolsConfig;
    readonly sessionId: string;
}

export async function createMonitorListToolRegistration(
    options: MonitorListToolOptions,
): Promise<ToolRegistration<MonitorListInput, MonitorListOutput> | null> {
    if (!options.config.enabled) {
        return null;
    }
    const resolved: MonitorListToolOptions = {
        manager: options.manager,
        config: options.config,
        sessionId: options.sessionId,
    };
    return {
        name: MONITOR_LIST_TOOL_NAME,
        description:
            'List monitors owned by the current session. Returns id, label, mode, startedAt, status, and counters; raw commands are never included. Terminal monitors are hidden unless include_exited=true.',
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: monitorListParametersJsonSchema(),
        inputSchema: monitorListInputSchema,
        outputSchema: monitorListOutputSchema,
        outputLimit: MONITOR_LIST_OUTPUT_LIMIT,
        execute: (input) => runMonitorList(resolved, input),
        toModelOutput: monitorListModelOutput,
    };
}

export async function registerMonitorListTool(
    registry: { register(registration: ToolRegistration<MonitorListInput, MonitorListOutput>): ToolAdvertisement },
    options: MonitorListToolOptions,
): Promise<ToolAdvertisement | null> {
    const registration = await createMonitorListToolRegistration(options);
    if (registration === null) {
        return null;
    }
    return registry.register(registration);
}

function monitorListParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            include_exited: {
                type: 'boolean',
                description: 'Include exited, stopped, and failed monitors. Defaults to false.',
            },
        },
        additionalProperties: false,
    };
}

async function runMonitorList(options: MonitorListToolOptions, input: MonitorListInput): Promise<MonitorListOutput> {
    const includeExited = input.include_exited ?? false;
    const records = options.manager.list(options.sessionId);
    const monitors = records
        .filter((record) => includeExited || !HIDDEN_STATUSES.has(record.status))
        .map((record) => ({
            id: record.id,
            label: record.label,
            mode: record.mode,
            startedAt: record.startedAt,
            status: record.status,
            counters: sanitizeCounters(record.counters),
        }));
    return { kind: 'monitor_list', monitors };
}

function sanitizeCounters(counters: MonitorCounters): z.infer<typeof monitorCountersSchema> {
    return {
        totalLines: counters.totalLines,
        matchedLines: counters.matchedLines,
        unmatchedLines: counters.unmatchedLines,
        droppedMatched: counters.droppedMatched,
        droppedUnmatched: counters.droppedUnmatched,
        bytesDropped: counters.bytesDropped,
        lastSequence: counters.lastSequence,
    };
}

function monitorListModelOutput(output: MonitorListOutput): string {
    if (output.monitors.length === 0) {
        return 'No monitors owned by this session.';
    }
    const header = `Monitors owned by this session (${output.monitors.length}):`;
    const lines = output.monitors.map((monitor) => {
        const counts = monitor.counters;
        return `- ${monitor.id} [${monitor.status}] label="${monitor.label}" mode=${monitor.mode} matched=${counts.matchedLines} unmatched=${counts.unmatchedLines} dropped=${counts.droppedMatched + counts.droppedUnmatched}`;
    });
    return [header, ...lines].join('\n');
}

export type { MonitorMode };
