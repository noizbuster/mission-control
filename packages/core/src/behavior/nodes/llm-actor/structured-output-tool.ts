/**
 * OpenCode-style forced structured output via a synthetic `generate_object` tool.
 *
 * Pure `outputKey` gates (tools suppressed) must not depend on free-text `true`/`false`
 * compliance. The model is forced to call this tool; the runtime decodes `value` and
 * writes it to the blackboard. This mirrors OpenCode's `LLM.generateObject` pattern
 * (`toolChoice` named + schema decode), adapted to the ABG single-step `streamText` loop.
 */
import type { AbgNodeSpec } from '@mission-control/protocol';
import { type Tool, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import {
    type ParseStructuredOutputResult,
    parseStructuredOutput,
} from '../../structured-blackboard';
import {
    buildStructuredOutputContract,
    readOutputEnum,
    readOutputShape,
} from './llm-actor-node-helpers';

export const GENERATE_OBJECT_TOOL_NAME = 'generate_object' as const;

const GENERATE_OBJECT_TOOL_DESCRIPTION =
    'Return the structured result by calling this tool. Put the entire result in `value`. Do not answer in free text.';

export type GenerateObjectCapture = {
    readonly value: unknown;
};

export function isGenerateObjectToolName(name: string): boolean {
    return name === GENERATE_OBJECT_TOOL_NAME;
}

/**
 * Build a Zod input schema for `generate_object` from node `outputShape` / `outputEnum`.
 * Always wraps the payload as `{ value: T }` so decode is shape-uniform.
 */
export function buildGenerateObjectInputSchema(node: AbgNodeSpec): z.ZodType<{ readonly value: unknown }> {
    const shape = readOutputShape(node);
    const outputEnum = readOutputEnum(node);

    if (outputEnum !== undefined && outputEnum.length > 0) {
        const [first, ...rest] = outputEnum;
        if (first === undefined) {
            return z.object({ value: z.string() });
        }
        return z.object({
            value: z.enum([first, ...rest]),
        });
    }

    switch (shape) {
        case 'boolean':
            return z.object({ value: z.boolean() });
        case 'array':
            return z.object({ value: z.array(z.unknown()) });
        case 'object':
            return z.object({ value: z.record(z.string(), z.unknown()) });
        case 'string':
            return z.object({ value: z.string().min(1) });
        case 'any':
            return z.object({ value: z.unknown() });
    }
}

export function createGenerateObjectTool(options: {
    readonly node: AbgNodeSpec;
    readonly onCapture: (capture: GenerateObjectCapture) => void;
}): Tool {
    const inputSchema = buildGenerateObjectInputSchema(options.node);
    return tool({
        description: GENERATE_OBJECT_TOOL_DESCRIPTION,
        inputSchema,
        execute: async (input) => {
            options.onCapture({ value: input.value });
            return { ok: true as const };
        },
    });
}

export function structuredOutputToolSystemDirective(): string {
    return (
        `STRUCTURED OUTPUT TOOL CONTRACT:\n` +
        `You MUST call the \`${GENERATE_OBJECT_TOOL_NAME}\` tool with the result in \`value\`.\n` +
        `Do not answer in free text. Do not continue prior exploration. Do not call any other tool.`
    );
}

export type PureStructuredGateTools = {
    readonly tools: ToolSet;
    readonly toolChoice: { readonly type: 'tool'; readonly toolName: typeof GENERATE_OBJECT_TOOL_NAME };
};

export function createPureStructuredGateTools(
    node: AbgNodeSpec,
    onCapture: (capture: GenerateObjectCapture) => void,
): PureStructuredGateTools {
    return {
        tools: {
            [GENERATE_OBJECT_TOOL_NAME]: createGenerateObjectTool({ node, onCapture }),
        },
        toolChoice: { type: 'tool', toolName: GENERATE_OBJECT_TOOL_NAME },
    };
}

export function resolveStructuredOutputFromTurn(options: {
    readonly node: AbgNodeSpec;
    readonly pureStructuredGate: boolean;
    readonly generateObjectCapture: GenerateObjectCapture | undefined;
    readonly turnText: string;
}): ParseStructuredOutputResult {
    if (options.generateObjectCapture !== undefined) {
        return { ok: true, value: options.generateObjectCapture.value };
    }
    const trimmed = options.turnText.trim();
    if (trimmed.length > 0) {
        return parseStructuredOutput(trimmed, readOutputShape(options.node));
    }
    return {
        ok: false,
        error: options.pureStructuredGate
            ? `model did not call forced \`${GENERATE_OBJECT_TOOL_NAME}\` tool`
            : 'empty structured output',
    };
}

export function appendStructuredOutputSystem(
    baseSystem: string,
    node: AbgNodeSpec,
    options: { readonly pureStructuredGate: boolean; readonly outputKey: string | undefined },
): string {
    if (options.outputKey === undefined) return baseSystem;
    const contract = options.pureStructuredGate
        ? structuredOutputToolSystemDirective()
        : buildStructuredOutputContract(node, options.outputKey);
    return `${baseSystem}\n\n${contract}`;
}
