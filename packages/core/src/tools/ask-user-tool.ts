import {
    type AskUserBlockedEvent,
    type AskUserInput,
    type AskUserOption,
    type AskUserOutput,
    type AskUserQuestion,
    type AskUserQuestionRequest,
    type AskUserToolOptions,
    askUserInputSchema,
    askUserOutputSchema,
    askUserParametersJsonSchema,
} from './ask-user-schemas';
import { ToolRegistry } from './tool-registry';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types';

export type {
    AskUserBlockedEvent,
    AskUserInput,
    AskUserOutput,
    AskUserQuestionRequest,
    AskUserToolOptions,
    AskUserUserInputWaitContext,
    AskUserUserInputWaitMirror,
} from './ask-user-schemas';
export { askUserInputSchema, askUserOutputSchema, askUserParametersJsonSchema } from './ask-user-schemas';
export {
    createAskUserWaitMirrorFromTaskMirror,
    createSqlAskUserUserInputWaitMirror,
    resolveAskUserInputWait,
    startAskUserInputWait,
    waitIdForAskUserToolCall,
} from './ask-user-wait-sql';

/** Sentinel returned in non-interactive mode; non-empty so it is not mistaken for a real free-text answer. */
export const ASK_USER_BLOCKED_ANSWER = '(blocked: awaiting user input — no interactive host)';

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
 * Non-interactive hosts set `nonInteractive: true`: the tool emits an
 * ask-blocked event (via `onAskBlocked`) and returns a deterministic sentinel
 * instead of awaiting a callback that would never resolve.
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
 * `undefined` values sneak through). When `recommended` is a valid index the
 * option at that index is promoted to position 0 (recommended-first), so the
 * host can treat the first option as the default without a separate flag.
 */
function buildQuestionRequest(question: AskUserQuestion): AskUserQuestionRequest {
    const ordered = recommendedFirst(question.options ?? [], question.recommended);
    return {
        question: question.question,
        options: ordered,
        ...(question.header !== undefined && { header: question.header }),
        ...(question.multiple !== undefined && { multiple: question.multiple }),
    };
}

function recommendedFirst(
    options: readonly AskUserOption[],
    recommended: number | undefined,
): readonly AskUserOption[] {
    if (recommended === undefined) return options;
    const pick = options[recommended];
    if (pick === undefined) return options;
    return [pick, ...options.slice(0, recommended), ...options.slice(recommended + 1)];
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

async function sequentialAnswers(
    options: AskUserToolOptions,
    requests: readonly AskUserQuestionRequest[],
): Promise<string[]> {
    const answers: string[] = [];
    for (const request of requests) {
        answers.push(await options.requestUserQuestion(request));
    }
    return answers;
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
        execute: async (input, context) => {
            const multiMode = input.questions !== undefined;
            // In multi-question mode `questions` takes precedence over the legacy
            // `options` field. Each entry is reordered recommended-first so the
            // host can default-select position 0. A host batch callback renders
            // all entries in one tabbed overlay; otherwise they are posed
            // sequentially.
            const requests: AskUserQuestionRequest[] = multiMode
                ? input.questions.map(buildQuestionRequest)
                : [{ question: input.question, options: input.options }];

            // Non-interactive hosts (--no-tui/--json) cannot block on a human.
            // Emit the ask-blocked event then return a sentinel — never await a
            // callback that would hang the run. Do not open a durable user_input wait.
            if (options.nonInteractive) {
                const event: AskUserBlockedEvent = {
                    question: input.question,
                    questions: requests,
                };
                options.onAskBlocked?.(event);
                return { answer: ASK_USER_BLOCKED_ANSWER };
            }

            const wait = options.userInputWait;
            if (wait !== undefined) {
                await wait.start({ toolCallId: context.toolCallId });
            }
            try {
                if (multiMode) {
                    const answers =
                        options.requestUserQuestions !== undefined
                            ? await options.requestUserQuestions(requests)
                            : await sequentialAnswers(options, requests);
                    const labeled = input.questions.map((question, i) =>
                        formatLabeledAnswer(question, answers[i] ?? ''),
                    );
                    return { answer: labeled.join('\n') };
                }
                const answer = await options.requestUserQuestion({
                    question: input.question,
                    options: input.options,
                });
                return { answer };
            } finally {
                if (wait !== undefined) {
                    await wait.resolve({ toolCallId: context.toolCallId });
                }
            }
        },
        // The execute layer already emits a labeled, newline-joined string for
        // multi-question responses, so the model-facing output passes through
        // unchanged. Formatting lives upstream because the output schema carries
        // a single `answer` field and no question context to label from here.
        toModelOutput: (output) => output.answer,
    };
}
