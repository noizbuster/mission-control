import type { AgentRuntime } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { type ChatLineAction, formatModelProviderSelection, parseChatLine } from './chat-commands.js';
import { createModelChoices, type ModelChoice } from './interactive-chat-model.js';
import { createTerminalModelSelector } from './interactive-chat-model-selector.js';
import { stdin as input, stdout as output } from 'node:process';

export type ChatInputEvent =
    | {
          readonly type: 'line';
          readonly value: string;
      }
    | {
          readonly type: 'interrupt';
          readonly interruptedPartialInput?: boolean;
      };

export type ChatInput = {
    readonly read: () => Promise<ChatInputEvent>;
    readonly close: () => void;
};

export type ChatOutput = {
    readonly write: (text: string) => void;
    readonly getOutput?: () => string;
};

export type ModelSelector = (
    choices: readonly ModelChoice[],
    currentSelection: ModelProviderSelection,
) => Promise<ModelProviderSelection | undefined>;

export type InteractiveChatOptions = {
    readonly input?: ChatInput;
    readonly output?: ChatOutput;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly authenticatedProviderIDs?: readonly string[];
    readonly modelChoices?: readonly ModelChoice[];
    readonly selectModel?: ModelSelector;
};

export const maxChatPromptLength = 8_000;

export async function runInteractiveChatSession(
    runtime: AgentRuntime,
    options: InteractiveChatOptions,
): Promise<string> {
    const chatInput = options.input ?? createTerminalChatInput();
    const chatOutput = options.output ?? createTerminalChatOutput();
    const selectModel = options.selectModel ?? createTerminalModelSelector(chatOutput);
    const modelChoices =
        options.modelChoices ??
        createModelChoices(
            options.authenticatedProviderIDs !== undefined ? { providerIDs: options.authenticatedProviderIDs } : {},
        );
    let currentModelProviderSelection = options.modelProviderSelection;
    let pendingInterrupt = false;

    try {
        chatOutput.write('mission-control chat\n');
        chatOutput.write(`model: ${formatModelProviderSelection(currentModelProviderSelection)}\n`);
        chatOutput.write('Press Ctrl+C twice to exit\n\n');

        for (;;) {
            chatOutput.write('You: ');
            const event = await chatInput.read();
            if (event.type === 'interrupt') {
                if (pendingInterrupt && event.interruptedPartialInput !== true) {
                    chatOutput.write('\n');
                    break;
                }
                pendingInterrupt = true;
                chatOutput.write('\nPress Ctrl+C again to exit\n');
                continue;
            }

            pendingInterrupt = false;
            const prompt = event.value.trim();
            if (prompt.length === 0) {
                continue;
            }
            if (prompt.length > maxChatPromptLength) {
                chatOutput.write(`Prompt is too long (max ${maxChatPromptLength} characters).\n`);
                continue;
            }

            const action = parseChatLine(prompt, { modelChoices });
            currentModelProviderSelection = await runChatAction(
                runtime,
                chatOutput,
                action,
                currentModelProviderSelection,
                selectModel,
                modelChoices,
            );
        }
    } finally {
        chatInput.close();
    }

    return chatOutput.getOutput?.() ?? '';
}

async function runChatAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    action: ChatLineAction,
    currentModelProviderSelection: ModelProviderSelection,
    selectModel: ModelSelector,
    modelChoices: readonly ModelChoice[],
): Promise<ModelProviderSelection> {
    switch (action.kind) {
        case 'empty':
            return currentModelProviderSelection;
        case 'prompt': {
            const response = await runtime.runPromptTask(action.prompt);
            chatOutput.write(`Assistant: ${response}\n`);
            return currentModelProviderSelection;
        }
        case 'model-status':
            chatOutput.write(`model: ${formatModelProviderSelection(currentModelProviderSelection)}\n`);
            return currentModelProviderSelection;
        case 'model-pick': {
            if (modelChoices.length === 0) {
                chatOutput.write('No models are available for logged-in providers\n');
                return currentModelProviderSelection;
            }
            const selection = await selectModel(modelChoices, currentModelProviderSelection);
            if (selection === undefined) {
                chatOutput.write(`model: ${formatModelProviderSelection(currentModelProviderSelection)}\n`);
                return currentModelProviderSelection;
            }
            runtime.setModelProviderSelection(selection);
            chatOutput.write(`model: ${formatModelProviderSelection(selection)}\n`);
            return selection;
        }
        case 'model-list':
            if (action.totalCount === 0) {
                chatOutput.write('No models are available for logged-in providers\n');
                return currentModelProviderSelection;
            }
            chatOutput.write(`Showing 1-${action.visibleChoices.length} of ${action.totalCount}\n`);
            for (const choice of action.visibleChoices) {
                chatOutput.write(`${choice.label}\n`);
            }
            return currentModelProviderSelection;
        case 'model':
            runtime.setModelProviderSelection(action.selection);
            chatOutput.write(`model: ${formatModelProviderSelection(action.selection)}\n`);
            return action.selection;
        case 'skill': {
            await runtime.runSkillInvocationTask({
                skillID: action.name,
                argumentsText: action.instruction,
            });
            const suffix = action.instruction.length > 0 ? `: ${action.instruction}` : '';
            chatOutput.write(`Skill ${action.name} scaffolded${suffix}\n`);
            return currentModelProviderSelection;
        }
        case 'unknown-slash':
            chatOutput.write(`Unknown command: /${action.command}\n`);
            return currentModelProviderSelection;
        case 'invalid':
            chatOutput.write(`${action.message}\n`);
            return currentModelProviderSelection;
        default:
            return assertNever(action);
    }
}

export function createTerminalChatOutput(): ChatOutput {
    return {
        write: (text: string) => {
            output.write(text);
        },
    };
}

export function createTerminalChatInput(): ChatInput {
    const wasRaw = input.isRaw === true;
    let closed = false;
    input.setRawMode(true);
    input.resume();

    return {
        read: async () => {
            if (closed) {
                return { type: 'interrupt' };
            }
            return readTerminalChatEvent();
        },
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            input.setRawMode(wasRaw);
            input.pause();
        },
    };
}

function readTerminalChatEvent(): Promise<ChatInputEvent> {
    return new Promise((resolve) => {
        const characters: string[] = [];

        function finish(event: ChatInputEvent): void {
            input.off('data', onData);
            resolve(event);
        }

        function onData(chunk: Buffer | string): void {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            if (text.startsWith('\u001b')) {
                return;
            }
            for (const character of text) {
                if (character === '\u0003') {
                    finish({
                        type: 'interrupt',
                        ...(characters.length > 0 ? { interruptedPartialInput: true } : {}),
                    });
                    return;
                }
                if (character === '\n' || character === '\r') {
                    output.write('\n');
                    finish({ type: 'line', value: characters.join('') });
                    return;
                }
                if (character === '\b' || character === '\u007f') {
                    if (characters.pop() !== undefined) {
                        output.write('\b \b');
                    }
                    continue;
                }
                if (characters.length >= maxChatPromptLength) {
                    output.write('\u0007');
                    continue;
                }
                characters.push(character);
                output.write(character);
            }
        }

        input.on('data', onData);
    });
}

function assertNever(value: never): never {
    throw new Error(`Unexpected chat action: ${String(value)}`);
}
