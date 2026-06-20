import {
    type AskUserInput,
    type AskUserOutput,
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
 * When the model needs a decision, clarification, or user input it cannot resolve with the
 * other tools, it calls `ask_user`. The tool delegates to a `requestUserQuestion` callback
 * (supplied by the host) that resolves with the user's answer — either a selected option or
 * a custom-typed string. The resolved answer is returned to the model as the tool result.
 *
 * Non-interactive hosts (no TUI) supply a callback that resolves with an empty string so the
 * tool degrades gracefully instead of hanging.
 */
export async function registerAskUserTool(
    registry: ToolRegistry,
    options: AskUserToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(createAskUserToolRegistration(options));
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
            const answer = await options.requestUserQuestion({
                question: input.question,
                options: input.options,
            });
            return { answer };
        },
        toModelOutput: (output) => output.answer,
    };
}
