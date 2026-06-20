import { z } from 'zod';

/**
 * `ask_user` schemas (Wave 3, task 7).
 *
 * The tool supports two input shapes:
 * 1. Single-question (legacy): `{ question, options? }` — backward compatible.
 * 2. Multi-question: `{ question, questions: AskUserQuestion[] }` — each entry
 *    carries its own options (label + description), optional header, and an
 *    optional `multiple` flag for multi-select.
 *
 * `question` stays required in both shapes; in multi-question mode it acts as a
 * short summary the host can surface alongside the per-question prompts. When
 * `questions` is provided it takes precedence over the legacy `options` field
 * (the precedence is resolved in the execute logic, not the schema).
 */

// ============== Zod schemas (runtime validation) ==============

export const askUserOptionSchema = z
    .object({
        label: z.string().min(1).max(500),
        description: z.string().max(4_000).optional(),
    })
    .strict();

export const askUserLegacyOptionSchema = z.union([z.string().min(1).max(500), askUserOptionSchema]);

export const askUserQuestionSchema = z
    .object({
        question: z.string().min(1).max(4_000),
        header: z.string().max(500).optional(),
        options: z.array(askUserOptionSchema).max(50).optional(),
        multiple: z.boolean().optional(),
    })
    .strict();

export const askUserInputSchema = z
    .object({
        question: z.string().min(1).max(4_000),
        options: z.array(askUserLegacyOptionSchema).max(50).default([]),
        questions: z.array(askUserQuestionSchema).max(50).optional(),
    })
    .strict();

export const askUserOutputSchema = z.object({ answer: z.string() }).strict();

// ============== Types (static typing, exactOptionalPropertyTypes-safe) ==============
// Optional fields carry an explicit `| undefined` to match Zod v4's inferred
// output for `.optional()`. Removing it breaks the `inputSchema: ZodType<X>`
// assignment in tool registrations under exactOptionalPropertyTypes.

export type AskUserOption = {
    readonly label: string;
    readonly description?: string | undefined;
};

export type AskUserQuestion = {
    readonly question: string;
    readonly header?: string | undefined;
    readonly options?: readonly AskUserOption[] | undefined;
    readonly multiple?: boolean | undefined;
};

export type AskUserInput = {
    readonly question: string;
    readonly options: readonly (string | AskUserOption)[];
    readonly questions?: readonly AskUserQuestion[] | undefined;
};

export type AskUserOutput = {
    readonly answer: string;
};

/**
 * Request payload passed to the host-supplied `requestUserQuestion` callback.
 * `options` accepts either the legacy `string[]` form or the new labeled
 * `AskUserOption[]` form so the same callback signature serves both modes.
 */
export type AskUserQuestionRequest = {
    readonly question: string;
    readonly options: readonly (string | AskUserOption)[];
    readonly header?: string;
    readonly multiple?: boolean;
};

export type AskUserToolOptions = {
    readonly requestUserQuestion: (request: AskUserQuestionRequest) => Promise<string>;
};

// ============== Model-facing JSON Schema ==============

export function askUserParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description:
                    'The primary question to ask the user. Required in both modes; ' +
                    'acts as a summary when `questions` is also provided.',
            },
            options: {
                type: 'array',
                items: {
                    oneOf: [
                        { type: 'string' },
                        {
                            type: 'object',
                            properties: {
                                label: { type: 'string', description: 'Display text for the option.' },
                                description: { type: 'string', description: 'Optional explanation.' },
                            },
                            required: ['label'],
                            additionalProperties: false,
                        },
                    ],
                },
                description:
                    'Selectable options. Each item can be a plain string or an object with label + description. ' +
                    'The user may also type a custom answer.',
            },
            questions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        question: { type: 'string', description: 'The question text.' },
                        header: {
                            type: 'string',
                            description: 'Short label shown above the question (max 500 chars).',
                        },
                        options: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    label: {
                                        type: 'string',
                                        description: 'Display text for the option (max 500 chars).',
                                    },
                                    description: {
                                        type: 'string',
                                        description: 'Optional explanation shown alongside the label.',
                                    },
                                },
                                required: ['label'],
                                additionalProperties: false,
                            },
                            description: 'Up to 50 labeled choices for the question.',
                        },
                        multiple: {
                            type: 'boolean',
                            description: 'When true, allow the user to select more than one option.',
                        },
                    },
                    required: ['question'],
                    additionalProperties: false,
                },
                description: 'Multi-question mode. When provided, takes precedence over `question`/`options`.',
            },
        },
        required: ['question'],
        additionalProperties: false,
    };
}
