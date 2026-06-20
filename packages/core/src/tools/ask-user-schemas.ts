import { z } from 'zod';

export const askUserInputSchema = z
    .object({
        question: z.string().min(1).max(4_000),
        options: z.array(z.string().min(1).max(500)).max(50).default([]),
    })
    .strict();
export type AskUserInput = z.infer<typeof askUserInputSchema>;

export const askUserOutputSchema = z.object({ answer: z.string() }).strict();
export type AskUserOutput = z.infer<typeof askUserOutputSchema>;

export type AskUserQuestionRequest = {
    readonly question: string;
    readonly options: readonly string[];
};

export type AskUserToolOptions = {
    readonly requestUserQuestion: (request: AskUserQuestionRequest) => Promise<string>;
};

export function askUserParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description: 'The question to ask the user.',
            },
            options: {
                type: 'array',
                items: { type: 'string' },
                description: 'Selectable options. The user may also type a custom answer.',
            },
        },
        required: ['question'],
        additionalProperties: false,
    };
}
