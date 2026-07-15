/**
 * `report_tool_issue` tool - automated QA grievance recorder.
 *
 * Ported from oh-my-pi (MIT). Lets the model flag unexpected tool behavior for
 * automated QA tracking. The original persists grievances to a local SQLite
 * database, resolves user consent for shipping them to a backend, and never
 * throws. This port keeps the never-throws contract and the consent/allowlist
 * semantics but replaces SQLite + Bun APIs with an injectable `onIssue`
 * callback so the tool stays free of runtime/storage internals and testable
 * in isolation. It is config-gated off by default: the CLI assembly only calls
 * {@linkcode registerReportToolIssueTool} when the auto-QA setting is enabled,
 * mirroring the opencode/oh-my-pi "do not collect by default" stance.
 *
 * Allowlist semantics: when `allowedToolNames` is non-empty, reports targeting
 * tools outside that set are silently acknowledged without recording (the
 * original "silently drop" guard for MCP/extension/typo tool names). An empty
 * allowlist records everything.
 */
import { z } from 'zod';
import { ToolRegistry } from './tool-registry';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types';

/** The canonical tool name so registry lookups avoid magic strings. */
export const REPORT_TOOL_ISSUE_TOOL_NAME = 'report_tool_issue';

export type ReportToolIssueInput = {
    readonly tool: string;
    readonly report: string;
};

export type ReportToolIssueStatus = 'recorded' | 'disabled' | 'dropped';

export type ReportToolIssueOutput = {
    readonly status: ReportToolIssueStatus;
    readonly message: string;
};

export type ReportToolIssue = {
    readonly tool: string;
    readonly report: string;
};

export type ReportToolIssueToolOptions = {
    /** When false (the default), the tool is not registered and never advertised. */
    readonly enabled: boolean;
    /**
     * Host hook invoked with each accepted grievance so the runtime can persist
     * or ship it. Never awaited in a way that blocks tool execution beyond the
     * callback itself; the original fires-and-forgets the network flush.
     */
    readonly onIssue?: (issue: ReportToolIssue) => void | Promise<void>;
    /**
     * When non-empty, reports targeting tools outside this set are silently
     * acknowledged without recording. An empty/absent allowlist records all.
     */
    readonly allowedToolNames?: readonly string[];
};

const reportToolIssueInputSchema = z
    .object({
        tool: z.string().min(1),
        report: z.string().min(1),
    })
    .strict();

const reportToolIssueOutputSchema = z
    .object({
        status: z.enum(['recorded', 'disabled', 'dropped']),
        message: z.string().min(1),
    })
    .strict();

const reportToolIssueParametersJsonSchema = {
    type: 'object',
    properties: {
        tool: { type: 'string', description: 'Tool name exhibiting unexpected behavior.' },
        report: {
            type: 'string',
            description:
                'Description of the unexpected behavior. Keep it generic; never include PII, paths, ' +
                'file contents, identifiers, or prompt text.',
        },
    },
    required: ['tool', 'report'],
    additionalProperties: false,
} as const;

const REPORT_TOOL_ISSUE_OUTPUT_LIMIT = { maxModelOutputChars: 500 } as const;

const ACK_MESSAGE = 'Noted, thanks!';

/**
 * Strip a `proxy_` passthrough prefix before the allowlist check, mirroring the
 * original. Models sometimes emit `proxy_<name>` for tools routed through a
 * passthrough wrapper; stripping ensures the report lands against the real tool.
 */
function canonicalToolName(tool: string): string {
    return tool.startsWith('proxy_') ? tool.slice('proxy_'.length) : tool;
}

export function createReportToolIssueToolRegistration(
    options: ReportToolIssueToolOptions,
): ToolRegistration<ReportToolIssueInput, ReportToolIssueOutput> {
    const allowSet = options.allowedToolNames === undefined ? null : new Set(options.allowedToolNames);
    return {
        name: REPORT_TOOL_ISSUE_TOOL_NAME,
        description: 'Report unexpected tool behavior for automated QA tracking.',
        capabilityClasses: ['read'],
        parametersJsonSchema: reportToolIssueParametersJsonSchema,
        inputSchema: reportToolIssueInputSchema,
        outputSchema: reportToolIssueOutputSchema,
        outputLimit: REPORT_TOOL_ISSUE_OUTPUT_LIMIT,
        execute: async (input) => {
            // Config gate honored at execute time too: a disabled registration
            // that somehow still receives a call degrades to a disabled status
            // rather than recording.
            if (!options.enabled) {
                return {
                    status: 'disabled',
                    message: 'Automated QA reporting is disabled. No grievance recorded.',
                };
            }
            const canonical = canonicalToolName(input.tool);
            // Silent drop for tools outside the known built-in set (MCP servers,
            // extensions, typos). The model did nothing wrong, so acknowledge
            // without recording and without surfacing an error.
            if (allowSet !== null && allowSet.size > 0 && !allowSet.has(canonical)) {
                return { status: 'dropped', message: ACK_MESSAGE };
            }
            // Never throws: the original wraps the persist + flush pipeline in a
            // try/catch that degrades to a logged error. Mirror that by guarding
            // the host callback.
            if (options.onIssue !== undefined) {
                try {
                    await options.onIssue({ tool: canonical, report: input.report });
                } catch {
                    // Swallow: tool execution must not fail because a grievance
                    // could not be recorded.
                }
            }
            return { status: 'recorded', message: ACK_MESSAGE };
        },
        toModelOutput: (output) => output.message,
    };
}

/**
 * Register the `report_tool_issue` tool only when `options.enabled` is true.
 * Returns `undefined` (no advertisement) when disabled, so config-gated callers
 * never surface the tool to the model. Mirrors the debug-tool self-gating seam.
 */
export function registerReportToolIssueTool(
    registry: ToolRegistry,
    options: ReportToolIssueToolOptions,
): ToolAdvertisement | undefined {
    if (!options.enabled) {
        return undefined;
    }
    return registry.register(createReportToolIssueToolRegistration(options));
}
