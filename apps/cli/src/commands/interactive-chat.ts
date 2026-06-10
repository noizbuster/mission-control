import type {
    AgentRuntime,
    CommandExecutionRequest,
    CommandExecutionResult,
    ProviderAdapter,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { formatModelProviderSelection, parseChatLine } from './chat-commands.js';
import { runChatAction } from './interactive-chat-actions.js';
import {
    type ChatInput,
    type ChatInputEvent,
    type ChatOutput,
    createTerminalChatInput,
    createTerminalChatOutput,
    maxChatPromptLength,
} from './interactive-chat-io.js';
import { createModelChoices, type ModelChoice } from './interactive-chat-model.js';
import { createTerminalModelSelector } from './interactive-chat-model-selector.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';

export type { ChatInput, ChatInputEvent, ChatOutput };

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
    readonly sessionId?: string;
    readonly provider?: ProviderAdapter;
    readonly workspaceRoot?: string;
    readonly emitEvent?: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

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
    let activeTurn: ActiveCodingAgentTurn | undefined;
    let turnCounter = 0;
    const inputPump = new ChatInputPump(chatInput);
    const sessionId = options.sessionId;

    try {
        chatOutput.write('mission-control chat\n');
        chatOutput.write(`model: ${formatModelProviderSelection(currentModelProviderSelection)}\n`);
        if (sessionId !== undefined) {
            chatOutput.write(`resumed session: ${sessionId}\n`);
        }
        chatOutput.write('Press Ctrl+C twice to exit\n\n');

        for (;;) {
            if (activeTurn === undefined) {
                chatOutput.write('You: ');
            }
            const next = await nextChatLoopEvent(inputPump, activeTurn);
            if (next.type === 'active-completed') {
                activeTurn = undefined;
                continue;
            }
            const event = next.event;
            if (event.type === 'interrupt') {
                if (activeTurn !== undefined) {
                    const interruptedTurn = activeTurn;
                    interruptedTurn.interrupt('soft');
                    await interruptedTurn.done;
                    activeTurn = undefined;
                    pendingInterrupt = false;
                    continue;
                }
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
            if (activeTurn?.hasPendingApproval() === true && activeTurn.answerApproval(prompt)) {
                continue;
            }
            if (activeTurn?.answerApproval(prompt)) {
                continue;
            }
            if (prompt.length === 0) {
                continue;
            }
            if (prompt.length > maxChatPromptLength) {
                chatOutput.write(`Prompt is too long (max ${maxChatPromptLength} characters).\n`);
                continue;
            }

            const action = parseChatLine(prompt, { modelChoices });
            const result = await runChatAction(
                runtime,
                chatOutput,
                action,
                currentModelProviderSelection,
                selectModel,
                modelChoices,
                {
                    activeTurn,
                    commandExecutor: options.commandExecutor,
                    emitEvent: options.emitEvent,
                    nextTurnId: () => {
                        turnCounter += 1;
                        return `turn_interactive_${turnCounter}`;
                    },
                    provider: options.provider,
                    sessionId,
                    workspaceRoot: options.workspaceRoot,
                },
            );
            currentModelProviderSelection = result.modelProviderSelection;
            activeTurn = result.activeTurn;
        }
    } finally {
        activeTurn?.interrupt('force');
        chatInput.close();
    }

    return chatOutput.getOutput?.() ?? '';
}

type ChatLoopEvent =
    | {
          readonly type: 'input';
          readonly event: ChatInputEvent;
      }
    | {
          readonly type: 'active-completed';
      };

class ChatInputPump {
    private pending: Promise<ChatInputEvent> | undefined;

    constructor(private readonly input: ChatInput) {}

    read(): Promise<ChatInputEvent> {
        if (this.pending === undefined) {
            this.pending = this.input.read().finally(() => {
                this.pending = undefined;
            });
        }
        return this.pending;
    }
}

async function nextChatLoopEvent(
    inputPump: ChatInputPump,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatLoopEvent> {
    if (activeTurn === undefined) {
        return { type: 'input', event: await inputPump.read() };
    }
    return Promise.race([
        activeTurn.done.then((): ChatLoopEvent => ({ type: 'active-completed' })),
        readAfterActiveYield(inputPump),
    ]);
}

async function readAfterActiveYield(inputPump: ChatInputPump): Promise<ChatLoopEvent> {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    return { type: 'input', event: await inputPump.read() };
}
