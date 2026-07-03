// Clean-room reimplementation of a background command monitor output tool.
// Origin: oh-my-openagent (Sustainable Use License) monitor_output tool. Reimplemented
// from scratch in mission-control's types; nothing copied. Attribution only.
//
// Config-gated: returns null when `config.enabled === false`. Returns retained output
// lines plus counters so agents can detect dropped lines. Unknown or unauthorized
// monitor IDs return a `not_found` result instead of throwing. Lines are already
// redacted and byte-capped at retention time.

import { z } from 'zod';
import type { MonitorCounters, MonitorManager, MonitorStream } from './monitor-manager.js';
import type { MonitorToolsConfig } from './monitor-start-tool.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry.js';

export const MONITOR_OUTPUT_TOOL_NAME = 'monitor_output';
const MONITOR_OUTPUT_LIMIT = { maxModelOutputChars: 16_000 } as const;

const monitorOutputCountersSchema = z
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

const monitorOutputLineSchema = z
    .object({
        stream: z.enum(['stdout', 'stderr']),
        seq: z.number().int().nonnegative(),
        text: z.string(),
        matched: z.boolean(),
        truncated: z.boolean(),
    })
    .strict();

export const monitorOutputInputSchema = z
    .object({
        monitor_id: z.string().min(1).max(256),
        stream: z.enum(['matched', 'unmatched', 'all']).optional(),
        since_sequence: z.number().int().nonnegative().optional(),
        limit: z.number().int().nonnegative().max(10_000).optional(),
    })
    .strict();
export type MonitorOutputInput = z.infer<typeof monitorOutputInputSchema>;

export const monitorOutputOutputSchema = z
    .object({
        kind: z.literal('monitor_output'),
        monitorId: z.string().min(1),
        lines: z.array(monitorOutputLineSchema),
        counters: monitorOutputCountersSchema,
        error: z.enum(['not_found']).optional(),
    })
    .strict();
export type MonitorOutputOutput = z.infer<typeof monitorOutputOutputSchema>;

export interface MonitorOutputToolOptions {
    readonly manager: MonitorManager;
    readonly config: MonitorToolsConfig;
    readonly sessionId: string;
}

export async function createMonitorOutputToolRegistration(
    options: MonitorOutputToolOptions,
): Promise<ToolRegistration<MonitorOutputInput, MonitorOutputOutput> | null> {
    if (!options.config.enabled) {
        return null;
    }
    const resolved: MonitorOutputToolOptions = {
        manager: options.manager,
        config: options.config,
        sessionId: options.sessionId,
    };
    return {
        name: MONITOR_OUTPUT_TOOL_NAME,
        description:
            'Retrieve retained output lines and counters for a monitor owned by the current session. Lines are redacted and byte-capped at retention time; counters expose dropped-line totals so the agent can detect eviction. Unknown or unauthorized monitor IDs return error="not_found" instead of throwing.',
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: monitorOutputParametersJsonSchema(),
        inputSchema: monitorOutputInputSchema,
        outputSchema: monitorOutputOutputSchema,
        outputLimit: MONITOR_OUTPUT_LIMIT,
        execute: (input) => runMonitorOutput(resolved, input),
        toModelOutput: monitorOutputModelOutput,
    };
}

export async function registerMonitorOutputTool(
    registry: { register(registration: ToolRegistration<MonitorOutputInput, MonitorOutputOutput>): ToolAdvertisement },
    options: MonitorOutputToolOptions,
): Promise<ToolAdvertisement | null> {
    const registration = await createMonitorOutputToolRegistration(options);
    if (registration === null) {
        return null;
    }
    return registry.register(registration);
}

function monitorOutputParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            monitor_id: {
                type: 'string',
                description: 'Monitor ID returned by monitor_start.',
            },
            stream: {
                type: 'string',
                enum: ['matched', 'unmatched', 'all'],
                description: 'Which retained stream to return. Defaults to all.',
            },
            since_sequence: {
                type: 'number',
                description: 'Return only lines with seq greater than this value.',
            },
            limit: {
                type: 'number',
                description: 'Maximum number of retained lines to return.',
            },
        },
        required: ['monitor_id'],
        additionalProperties: false,
    };
}

async function runMonitorOutput(
    options: MonitorOutputToolOptions,
    input: MonitorOutputInput,
): Promise<MonitorOutputOutput> {
    const record = options.manager.get(input.monitor_id);
    if (record === undefined || record.parentSessionId !== options.sessionId) {
        return {
            kind: 'monitor_output',
            monitorId: input.monitor_id,
            lines: [],
            counters: emptyCounters(),
            error: 'not_found',
        };
    }
    const result = options.manager.getOutput(input.monitor_id, {
        ...(input.stream !== undefined ? { stream: input.stream } : {}),
        ...(input.since_sequence !== undefined ? { since_sequence: input.since_sequence } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return {
        kind: 'monitor_output',
        monitorId: input.monitor_id,
        lines: result.lines.map((line) => ({
            stream: line.stream as MonitorStream,
            seq: line.seq,
            text: line.text,
            matched: line.matched,
            truncated: line.truncated,
        })),
        counters: sanitizeCounters(result.counters),
    };
}

function emptyCounters(): MonitorCounters {
    return {
        totalLines: 0,
        matchedLines: 0,
        unmatchedLines: 0,
        droppedMatched: 0,
        droppedUnmatched: 0,
        bytesDropped: 0,
        lastSequence: 0,
    };
}

function sanitizeCounters(counters: MonitorCounters): z.infer<typeof monitorOutputCountersSchema> {
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

function monitorOutputModelOutput(output: MonitorOutputOutput): string {
    if (output.error === 'not_found') {
        return `Monitor ${output.monitorId} not found (unknown id or owned by another session).`;
    }
    const counts = output.counters;
    const header = `monitor ${output.monitorId} — ${output.lines.length} line(s) retained for this response`;
    const dropped = counts.droppedMatched + counts.droppedUnmatched;
    const droppedNote =
        dropped > 0
            ? `\nretention dropped ${dropped} older line(s); counters: matched=${counts.matchedLines} unmatched=${counts.unmatchedLines} lastSeq=${counts.lastSequence}`
            : '';
    const body = output.lines.map((line) => formatLine(line)).join('\n');
    return body.length === 0 ? `${header}${droppedNote}` : `${header}${droppedNote}\n${body}`;
}

type OutputLine = z.infer<typeof monitorOutputLineSchema>;

function formatLine(line: OutputLine): string {
    const tag = line.matched ? '[MATCH]' : line.stream === 'stderr' ? '[ERR]' : '';
    const truncation = line.truncated ? ' [truncated]' : '';
    return `${tag} #${line.seq} ${line.text}${truncation}`.trim();
}
