/**
 * `invalid` tool - synthetic error sink.
 *
 * Ported from opencode (MIT). The original is a sink the runtime redirects a
 * malformed tool call to when the model emits arguments that fail schema
 * validation against the intended tool. Rather than crashing, the framework
 * rewrites the call to target `invalid` with the offending tool name and the
 * parse error, and this tool echoes a deterministic message back to the model
 * so it can correct itself on the next turn.
 *
 * Ported from Effect/Schema to plain TypeScript + Zod. No side effects; the
 * tool only reflects its inputs.
 */
import { z } from 'zod';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';

/** The canonical tool name so registry lookups avoid magic strings. */
export const INVALID_TOOL_NAME = 'invalid';

export type InvalidInput = {
    readonly tool: string;
    readonly error: string;
};

export type InvalidOutput = {
    readonly title: string;
    readonly output: string;
};

export type InvalidToolOptions = Record<string, never>;

const invalidInputSchema = z
    .object({
        tool: z.string().min(1),
        error: z.string().min(1),
    })
    .strict();

const invalidOutputSchema = z
    .object({
        title: z.string().min(1),
        output: z.string().min(1),
    })
    .strict();

const invalidParametersJsonSchema = {
    type: 'object',
    properties: {
        tool: { type: 'string', description: 'The tool name whose arguments were invalid.' },
        error: { type: 'string', description: 'The validation error explaining why the arguments were rejected.' },
    },
    required: ['tool', 'error'],
    additionalProperties: false,
} as const;

const INVALID_OUTPUT_LIMIT = { maxModelOutputChars: 1000 } as const;

export function createInvalidToolRegistration(
    _options: InvalidToolOptions = {},
): ToolRegistration<InvalidInput, InvalidOutput> {
    return {
        name: INVALID_TOOL_NAME,
        description: 'Do not use. Synthetic sink the framework routes a malformed tool call to.',
        capabilityClasses: ['read'],
        parametersJsonSchema: invalidParametersJsonSchema,
        inputSchema: invalidInputSchema,
        outputSchema: invalidOutputSchema,
        outputLimit: INVALID_OUTPUT_LIMIT,
        execute: (input) => ({
            title: 'Invalid Tool',
            output: `The arguments provided to the tool are invalid: ${input.error}`,
        }),
        toModelOutput: (output) => `${output.title}: ${output.output}`,
    };
}

export function registerInvalidTool(registry: ToolRegistry): ToolAdvertisement {
    return registry.register(createInvalidToolRegistration());
}
