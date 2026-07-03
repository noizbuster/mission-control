/**
 * `debug` tool — DAP (Debug Adapter Protocol) scaffold seam.
 *
 * Registers and advertises to the model ONLY when the caller opts in via
 * {@linkcode DebugToolOptions.enabled} (config-gated off by default: the CLI assembly
 * reads `debug.enabled` and only calls {@linkcode registerDebugTool} when true). Mirrors
 * the mission-control convention for providers-without-adapters: the catalog of adapters
 * (lldb-dap, debugpy, dlv, js-debug) is declared in `@mission-control/protocol`, but
 * execution is deferred. Invoking {@linkcode DebugToolRegistration.execute} returns
 * `{ status: 'not_yet_implemented' }` rather than crashing, so a model that discovers the
 * tool receives a clear promotable signal instead of a thrown error.
 *
 * A real DAP stdio transport + stepping/breakpoint engine is follow-up work; this seam
 * exists so the tool surface, capability class, and adapter registry contract are stable
 * before the engine lands.
 */
import { BUILTIN_DAP_ADAPTERS, type DapAdapter } from '@mission-control/protocol';
import { z } from 'zod';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';

export const DEBUG_TOOL_NAME = 'debug';

export type DebugInput = {
    readonly adapter: string;
    readonly command: string;
};

export type DebugOutput = {
    readonly status: 'not_yet_implemented';
    readonly adapter: string;
    readonly command: string;
    readonly message: string;
};

export type DebugToolOptions = {
    /** When false (the default), the tool is not registered and never advertised. */
    readonly enabled: boolean;
};

const NOT_YET_IMPLEMENTED_MESSAGE =
    'debug DAP engine not yet implemented: the adapter registry is declared but no transport is wired. ' +
    'A follow-up plan must promote this seam before stepping, breakpoints, or evaluation can run.';

const debugInputSchema = z.object({
    adapter: z.string().min(1),
    command: z.string().min(1),
});

const debugOutputSchema = z.object({
    status: z.literal('not_yet_implemented'),
    adapter: z.string(),
    command: z.string(),
    message: z.string(),
});

const debugParametersJsonSchema = {
    type: 'object',
    properties: {
        adapter: {
            type: 'string',
            description:
                'DAP adapter id (one of: ' +
                BUILTIN_DAP_ADAPTERS.map((entry: DapAdapter) => entry.id).join(', ') +
                '). Currently a catalog seam; execution is deferred.',
        },
        command: {
            type: 'string',
            description: 'Debug action to perform (launch, attach, continue, step_*, etc.).',
        },
    },
    required: ['adapter', 'command'],
    additionalProperties: false,
} as const;

export function createDebugToolRegistration(): ToolRegistration<DebugInput, DebugOutput> {
    return {
        name: DEBUG_TOOL_NAME,
        description:
            'Drive a debugger through a Debug Adapter Protocol (DAP) adapter. Scaffold seam: ' +
            'registers and advertises but execution is deferred — returns not_yet_implemented until ' +
            'a DAP engine is promoted by a follow-up plan.',
        capabilityClasses: ['exec'],
        parametersJsonSchema: debugParametersJsonSchema,
        inputSchema: debugInputSchema,
        outputSchema: debugOutputSchema,
        outputLimit: { maxModelOutputChars: 2_000 },
        execute: (input) => notYetImplemented(input),
        toModelOutput: (output) => `[debug] ${output.status}: ${output.message}`,
    };
}

function notYetImplemented(input: DebugInput): DebugOutput {
    return {
        status: 'not_yet_implemented',
        adapter: input.adapter,
        command: input.command,
        message: NOT_YET_IMPLEMENTED_MESSAGE,
    };
}

/**
 * Register the `debug` tool only when `options.enabled` is true. Returns `undefined`
 * (no advertisement) when disabled, so callers that gate on config never surface the
 * tool to the model. This is the self-gating seam the CLI assembly calls.
 */
export function registerDebugTool(registry: ToolRegistry, options: DebugToolOptions): ToolAdvertisement | undefined {
    if (!options.enabled) {
        return undefined;
    }
    return registry.register(createDebugToolRegistration());
}
