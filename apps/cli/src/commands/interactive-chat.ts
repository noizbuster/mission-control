import type {
    AgentRuntime,
    CommandExecutionRequest,
    CommandExecutionResult,
    JsonlSessionEventStore,
    ProviderAdapter,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { parseChatLine } from './chat-commands.js';
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
import { formatModelProviderStatus } from './interactive-chat-status.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';

export type { ChatInput, ChatInputEvent, ChatOutput };

export type ModelSelector = (
    choices: readonly ModelChoice[],
    currentSelection: ModelProviderSelection,
    options?: { readonly title?: string },
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
    readonly resolveProviderForSelection?: (selection: ModelProviderSelection) => ProviderAdapter;
    readonly workspaceRoot?: string;
    readonly emitEvent?: (event: AgentEvent) => void;
    readonly observeStoredEvent?: (event: AgentEvent) => void;
    readonly sessionStore?: JsonlSessionEventStore;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly persistModelProviderSelection?: (selection: ModelProviderSelection) => Promise<void>;
};

export async function runInteractiveChatSession(
    runtime: AgentRuntime,
    options: InteractiveChatOptions,
): Promise<string> {
    const chatInput = options.input ?? createTerminalChatInput();
    const chatOutput = options.output ?? createTerminalChatOutput();
    const selectModel = suspendChatInputWhileSelectingModel(
        options.selectModel ?? createTerminalModelSelector(chatOutput),
        chatInput,
    );
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
    let currentProvider = options.resolveProviderForSelection?.(currentModelProviderSelection) ?? options.provider;
    const unregisterProcessCleanup = registerProcessTerminalCleanup(chatInput);

    try {
        chatOutput.write('mission-control chat\n');
        chatOutput.write(formatModelProviderStatus(currentModelProviderSelection, { nodeMode: 'none' }));
        if (sessionId !== undefined) {
            chatOutput.write(`resumed session: ${sessionId}\n`);
        }
        chatOutput.write('Press Ctrl+C twice or /exit to exit\n\n');

        for (;;) {
            if (activeTurn === undefined) {
                if (chatInput.controlsPrompt === true) {
                    chatInput.renderPrompt?.({ modelProviderSelection: currentModelProviderSelection });
                } else {
                    chatOutput.write('> ');
                }
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
                    chatOutput.write('\nPress Ctrl+C twice to exit\n');
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
            if (action.kind === 'exit') {
                activeTurn = await stopActiveTurn(activeTurn);
                chatOutput.write('Exiting mission-control chat\n');
                break;
            }
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
                    observeStoredEvent: options.observeStoredEvent,
                    nextTurnId: () => {
                        turnCounter += 1;
                        return `turn_interactive_${turnCounter}`;
                    },
                    provider: currentProvider,
                    sessionId,
                    sessionStore: options.sessionStore,
                    workspaceRoot: options.workspaceRoot,
                },
            );
            if (!areModelProviderSelectionsEqual(currentModelProviderSelection, result.modelProviderSelection)) {
                currentProvider =
                    options.resolveProviderForSelection?.(result.modelProviderSelection) ?? currentProvider;
                await options.persistModelProviderSelection?.(result.modelProviderSelection);
            }
            currentModelProviderSelection = result.modelProviderSelection;
            activeTurn = result.activeTurn;
        }
    } finally {
        unregisterProcessCleanup();
        activeTurn?.interrupt('force');
        chatInput.close();
    }

    return chatOutput.getOutput?.() ?? '';
}

async function stopActiveTurn(activeTurn: ActiveCodingAgentTurn | undefined): Promise<undefined> {
    if (activeTurn === undefined) {
        return undefined;
    }
    activeTurn.interrupt('force');
    await activeTurn.done;
    return undefined;
}

function areModelProviderSelectionsEqual(left: ModelProviderSelection, right: ModelProviderSelection): boolean {
    return left.providerID === right.providerID && left.modelID === right.modelID && left.variantID === right.variantID;
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
        setTimeout(resolve, 25);
    });
    return { type: 'input', event: await inputPump.read() };
}

function suspendChatInputWhileSelectingModel(selectModel: ModelSelector, input: ChatInput): ModelSelector {
    return async (choices, currentSelection, options) => {
        input.suspend?.();
        try {
            return await selectModel(choices, currentSelection, options);
        } finally {
            input.resume?.();
        }
    };
}

function registerProcessTerminalCleanup(input: ChatInput): () => void {
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) {
            return;
        }
        cleaned = true;
        input.close();
    };
    const onSignal = () => {
        cleanup();
    };
    const onExit = () => {
        cleanup();
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('exit', onExit);

    return () => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('exit', onExit);
    };
}
