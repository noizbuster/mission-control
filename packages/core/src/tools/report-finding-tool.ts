/**
 * `report_finding` tool - structured subagent finding submission.
 *
 * Ported from oh-my-pi (MIT). Used by reviewer/critic subagents to submit
 * structured findings during a code review. It pairs with the `yield` tool:
 * `report_finding` accumulates individual findings, then `yield` submits the
 * final result. The tool itself validates and acknowledges; an injectable
 * `onFinding` callback lets the parent runtime splice the finding into its
 * findings array (mirroring how `yield` findings are spliced).
 *
 * Ported from arktype to Zod and stripped of the TUI renderer concerns, which
 * are not part of the core tool surface.
 */
import { z } from 'zod';
import { ToolRegistry } from './tool-registry';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types';

/** The canonical tool name so registry lookups avoid magic strings. */
export const REPORT_FINDING_TOOL_NAME = 'report_finding';

export const FINDING_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type FindingPriority = (typeof FINDING_PRIORITIES)[number];

export type ReportFinding = {
    readonly title: string;
    readonly body: string;
    readonly priority: FindingPriority;
    readonly confidence: number;
    readonly file_path: string;
    readonly line_start: number;
    readonly line_end: number;
};

export type ReportFindingInput = ReportFinding;

export type ReportFindingOutput = {
    readonly status: 'recorded';
    readonly finding: ReportFinding;
};

export type ReportFindingToolOptions = {
    /**
     * Host hook invoked with each accepted finding so the parent runtime can
     * accumulate it. Mirrors the `yield` findings-splice seam.
     */
    readonly onFinding?: (finding: ReportFinding) => void | Promise<void>;
};

export const reportFindingInputSchema = z
    .object({
        title: z.string().min(1),
        body: z.string().min(1),
        priority: z.enum(FINDING_PRIORITIES),
        confidence: z.number().min(0).max(1),
        file_path: z.string().min(1),
        line_start: z.number(),
        line_end: z.number(),
    })
    .strict();

const reportFindingOutputSchema = z
    .object({
        status: z.literal('recorded'),
        finding: reportFindingInputSchema,
    })
    .strict();

const reportFindingParametersJsonSchema = {
    type: 'object',
    properties: {
        title: { type: 'string', description: 'Prefixed imperative title summarizing the finding.' },
        body: { type: 'string', description: 'Problem explanation.' },
        priority: { type: 'string', enum: [...FINDING_PRIORITIES], description: 'Severity priority 0-3.' },
        confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Confidence score between 0 and 1.',
        },
        file_path: { type: 'string', description: 'File path the finding refers to.' },
        line_start: { type: 'number', description: 'Start line of the finding range.' },
        line_end: { type: 'number', description: 'End line of the finding range.' },
    },
    required: ['title', 'body', 'priority', 'confidence', 'file_path', 'line_start', 'line_end'],
    additionalProperties: false,
} as const;

const REPORT_FINDING_OUTPUT_LIMIT = { maxModelOutputChars: 1500 } as const;

export function formatFindingLocation(finding: ReportFinding): string {
    const range = finding.line_end !== finding.line_start ? `-${finding.line_end}` : '';
    return `${finding.file_path}:${finding.line_start}${range}`;
}

export function createReportFindingToolRegistration(
    options: ReportFindingToolOptions = {},
): ToolRegistration<ReportFindingInput, ReportFindingOutput> {
    return {
        name: REPORT_FINDING_TOOL_NAME,
        description: 'Report a code review finding. Use this for each issue found. Call yield when done reviewing.',
        capabilityClasses: ['read'],
        parametersJsonSchema: reportFindingParametersJsonSchema,
        inputSchema: reportFindingInputSchema,
        outputSchema: reportFindingOutputSchema,
        outputLimit: REPORT_FINDING_OUTPUT_LIMIT,
        execute: async (input) => {
            if (options.onFinding !== undefined) {
                await options.onFinding(input);
            }
            return { status: 'recorded', finding: input };
        },
        toModelOutput: (output) =>
            `Finding recorded: ${output.finding.priority} ${output.finding.title}\n` +
            `Location: ${formatFindingLocation(output.finding)}\n` +
            `Confidence: ${Math.round(output.finding.confidence * 100)}%`,
        guideline:
            'Call report_finding once per review issue with a clear title, body, priority, confidence, ' +
            'and an exact file location. Pair it with yield to submit the overall review verdict.',
    };
}

export function registerReportFindingTool(
    registry: ToolRegistry,
    options: ReportFindingToolOptions = {},
): ToolAdvertisement {
    return registry.register(createReportFindingToolRegistration(options));
}
