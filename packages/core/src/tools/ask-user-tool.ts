import {
    type AskUserInput,
    type AskUserOutput,
    type AskUserQuestion,
    type AskUserQuestionRequest,
    type AskUserToolOptions,
    askUserInputSchema,
    askUserOutputSchema,
    askUserParametersJsonSchema,
} from './ask-user-schemas.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';
import { ToolRegistry } from './tool-registry.js';

export type { AskUserInput, AskUserOutput, AskUserQuestionRequest, AskUserToolOptions } from './ask-user-schemas.js';
export { askUserInputSchema, askUserOutputSchema, askUserParametersJsonSchema } from './ask-user-schemas.js';

/**
 * `ask_user` tool — interactive question surface for the model.
 *
 * Two input shapes are supported:
 * 1. Single-question (legacy): `{ question, options? }`. Backward compatible.
 * 2. Multi-question: `{ question, questions: [...] }`. Each entry is posed
 *    sequentially to the host callback; the labeled responses are joined into
 *    a single `answer` string so the model can correlate each answer with the
 *    prompt that produced it.
 *
 * Non-interactive hosts supply a callback that resolves with an empty string
 * so the tool degrades gracefully instead of hanging.
 */
export async function registerAskUserTool(
    registry: ToolRegistry,
    options: AskUserToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(createAskUserToolRegistration(options));
}

/**
 * Build a callback request from a multi-question entry. The `&&`-guarded
 * spreads add `header`/`multiple` only when they are actually present, so the
 * resulting object honours `exactOptionalPropertyTypes` (no explicit
 * `undefined` values sneak through).
 */
function buildQuestionRequest(question: AskUserQuestion): AskUserQuestionRequest {
    return {
        question: question.question,
        options: question.options ?? [],
        ...(question.header !== undefined && { header: question.header }),
        ...(question.multiple !== undefined && { multiple: question.multiple }),
    };
}

/**
 * Format one multi-question response with a label the model can correlate
 * with the original prompt. Prefers the optional `header`; falls back to the
 * question text so every answer is identifiable inside the joined output.
 */
function formatLabeledAnswer(question: AskUserQuestion, answer: string): string {
    const label = question.header ?? question.question;
    return `${label}: ${answer}`;
}

export function createAskUserToolRegistration(
    options: AskUserToolOptions,
): ToolRegistration<AskUserInput, AskUserOutput> {
    return {
        name: 'ask_user',
        description:
            'Ask the user a question. Use when you need user input, a decision, or clarification. ' +
            'The user can select from provided options or type a custom answer.',
        capabilityClasses: ['read'],
        parametersJsonSchema: askUserParametersJsonSchema(),
        inputSchema: askUserInputSchema,
        outputSchema: askUserOutputSchema,
        outputLimit: { maxModelOutputChars: 4000 },
        guideline:
            'Use ask_user when you need user input or a decision you cannot resolve with other tools. ' +
            'Provide clear options when possible; the user may also type a custom answer. ' +
            'Do not use ask_user for information you can obtain yourself by reading files or running commands.',
        execute: async (input) => {
            // Multi-question mode: `questions` takes precedence over the legacy
            // `options` field. Sequential invocation preserves order and lets
            // hosts render one prompt at a time.
            if (input.questions !== undefined) {
                const answers: string[] = [];
                for (const question of input.questions) {
                    const response = await options.requestUserQuestion(buildQuestionRequest(question));
                    answers.push(formatLabeledAnswer(question, response));
                }
                return { answer: answers.join('\n') };
            }
            const answer = await options.requestUserQuestion({
                question: input.question,
                options: input.options,
            });
            return { answer };
        },
        // The execute layer already emits a labeled, newline-joined string for
        // multi-question responses, so the model-facing output passes through
        // unchanged. Formatting lives upstream because the output schema carries
        // a single `answer` field and no question context to label from here.
        toModelOutput: (output) => output.answer,
    };
}
