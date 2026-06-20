import {
    type AgentRuntime,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    discoverSkills,
    type JsonlSessionEventStore,
    type ProviderAdapter,
    type SdkModelResolver,
    type Skill,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { parseChatLine } from './chat-commands.js';
import { createInkChatBridge, type InkChatBridgeOptions } from './ink-chat-bridge.js';
import { createInkChatInput } from './ink-chat-input.js';
import { createInkChatOutput } from './ink-chat-output.js';
import { createInkModelSelector } from './ink-model-selector.js';
import type { ChatActionResult } from './interactive-chat-action-result.js';
import { runChatAction } from './interactive-chat-actions.js';
import {
    type ChatInput,
    type ChatInputEvent,
    type ChatOutput,
    createTerminalChatInput,
    createTerminalChatOutput,
    maxChatPromptLength,
} from './interactive-chat-io.js';
import {
    areModelProviderSelectionsEqual,
    ChatInputPump,
    nextChatLoopEvent,
    registerProcessTerminalCleanup,
    stopActiveTurn,
    suspendChatInputWhileSelectingModel,
} from './interactive-chat-loop-support.js';
import { createModelChoices, type ModelChoice } from './interactive-chat-model.js';
import { createTerminalModelSelector } from './interactive-chat-model-selector.js';
import { createSessionNavigationController } from './interactive-chat-session-navigation.js';
import { formatModelProviderStatus } from './interactive-chat-status.js';
import { createUndoRedoStack, type UndoRedoStack } from './interactive-chat-undo-redo-stack.js';
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
    readonly switchSessionStore?: (sessionId: string) => Promise<JsonlSessionEventStore>;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly persistModelProviderSelection?: (selection: ModelProviderSelection) => Promise<void>;
    /**
     * Execution engine for coding turns. `'graph'` is the only supported value (the flat engine has
     * been removed). `resolveSdkModel` resolves the AI-SDK model for the selection.
     */
    readonly engine?: 'graph';
    readonly resolveSdkModel?: SdkModelResolver;
};

export async function runInteractiveChatSession(
    runtime: AgentRuntime,
    options: InteractiveChatOptions,
): Promise<string> {
    const useInk = options.input === undefined && process.stdin.isTTY === true;
    type SessionBridgeOptions = Omit<InkChatBridgeOptions, 'providerID' | 'modelID' | 'variantID'> & {
        providerID: string;
        modelID: string;
        variantID?: string;
        sessionDisplayName?: string;
    };
    const bridgeOptions: SessionBridgeOptions | undefined = useInk
        ? {
              providerID: options.modelProviderSelection.providerID,
              modelID: options.modelProviderSelection.modelID,
              ...(options.modelProviderSelection.variantID !== undefined
                  ? { variantID: options.modelProviderSelection.variantID }
                  : {}),
              ...(options.sessionId !== undefined ? { sessionID: options.sessionId } : {}),
          }
        : undefined;
    const inkBridge = useInk && bridgeOptions !== undefined ? createInkChatBridge(bridgeOptions) : undefined;
    const chatInput =
        options.input ?? (inkBridge !== undefined ? createInkChatInput(inkBridge) : createTerminalChatInput());
    const baseChatOutput =
        options.output ?? (inkBridge !== undefined ? createInkChatOutput(inkBridge) : createTerminalChatOutput());
    // Mirror of the conversation text for /undo and /redo. This is display-only;
    // the durable JSONL session log is never modified by undo/redo.
    let conversationText = '';
    let undoRedoStack = createUndoRedoStack();
    const chatOutput: ChatOutput = {
        ...baseChatOutput,
        write: (text: string) => {
            conversationText += text;
            baseChatOutput.write(text);
        },
    };
    const undoRedoController = {
        // The Ink bridge echoes "You: ..." directly to core.outputText, bypassing
        // the conversationText mirror; prefer the bridge's full text when present.
        readOutputText: () => inkBridge?.getOutput() ?? conversationText,
        replaceOutputText: (next: string) => {
            conversationText = next;
            inkBridge?.replaceOutputText(next);
        },
        getStack: () => undoRedoStack,
        setStack: (next: UndoRedoStack) => {
            undoRedoStack = next;
        },
    };
    const selectModel =
        inkBridge !== undefined
            ? createInkModelSelector(inkBridge)
            : suspendChatInputWhileSelectingModel(
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
    let currentSessionId = options.sessionId;
    let currentProvider = options.resolveProviderForSelection?.(currentModelProviderSelection) ?? options.provider;
    let currentSessionStore = options.sessionStore;
    let sessionDisplayName: string | undefined;
    const sessionDisplayNameController = {
        current: () => sessionDisplayName,
        update: (name: string) => {
            sessionDisplayName = name;
            if (bridgeOptions !== undefined) {
                bridgeOptions.sessionDisplayName = name;
            }
        },
    };
    const switchSessionStore = options.switchSessionStore;
    const sessionNavigation =
        switchSessionStore === undefined
            ? undefined
            : createSessionNavigationController({
                  getCurrentSessionId: () => (currentSessionStore === undefined ? undefined : currentSessionId),
                  getCurrentStore: () => currentSessionStore,
                  switchSessionStore: async (sessionId) => {
                      const store = await switchSessionStore(sessionId);
                      currentSessionId = sessionId;
                      currentSessionStore = store;
                      return store;
                  },
                  ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
                  ...(options.observeStoredEvent !== undefined
                      ? { observeStoredEvent: options.observeStoredEvent }
                      : {}),
              });
    const unregisterProcessCleanup = inkBridge === undefined ? registerProcessTerminalCleanup(chatInput) : undefined;

    if (inkBridge !== undefined) {
        inkBridge.setModelCycleChoices(modelChoices);
        inkBridge.onModelCycleSelect = (selection) => {
            currentModelProviderSelection = selection;
            currentProvider = options.resolveProviderForSelection?.(selection) ?? currentProvider;
            if (bridgeOptions !== undefined) {
                bridgeOptions.providerID = selection.providerID;
                bridgeOptions.modelID = selection.modelID;
                if (selection.variantID !== undefined) {
                    bridgeOptions.variantID = selection.variantID;
                } else {
                    delete bridgeOptions.variantID;
                }
            }
        };
        inkBridge.onRenameSubmit = (name: string) => {
            sessionDisplayNameController.update(name);
        };
    }

    const discoveredSkills =
        options.workspaceRoot !== undefined
            ? await discoverSkills({ workspaceRoot: options.workspaceRoot })
            : { skills: [], diagnostics: [] };
    const knownSkillNames = new Set<string>(discoveredSkills.skills.map((skill) => skill.name));
    const sessionSkills: readonly Skill[] = discoveredSkills.skills;

    try {
        chatOutput.write('mission-control chat\n');
        chatOutput.write(formatModelProviderStatus(currentModelProviderSelection, { nodeMode: 'none' }));
        if (currentSessionId !== undefined && currentSessionStore !== undefined) {
            chatOutput.write(`resumed session: ${currentSessionId}\n`);
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

            const action = parseChatLine(prompt, {
                modelChoices,
                knownSkillNames,
                ...(currentSessionId !== undefined ? { currentSessionId } : {}),
            });
            if (action.kind === 'exit') {
                activeTurn = await stopActiveTurn(activeTurn);
                chatOutput.write('Exiting mission-control chat\n');
                break;
            }
            let result: ChatActionResult;
            if (inkBridge !== undefined) {
                inkBridge.setGenerating(true);
            }
            try {
                result = await runChatAction(
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
                        sessionId: currentSessionId,
                        sessionStore: currentSessionStore,
                        workspaceRoot: options.workspaceRoot,
                        skills: sessionSkills,
                        sessionDisplayName: sessionDisplayNameController,
                        undoRedo: undoRedoController,
                        ...(sessionNavigation !== undefined ? { sessionNavigation } : {}),
                        ...(options.engine !== undefined ? { engine: options.engine } : {}),
                        ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
                    },
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                chatOutput.write(`Error: ${message}\n`);
                if (inkBridge !== undefined) {
                    inkBridge.setGenerating(false);
                }
                continue;
            }
            if (inkBridge !== undefined) {
                inkBridge.setGenerating(false);
            }
            if (!areModelProviderSelectionsEqual(currentModelProviderSelection, result.modelProviderSelection)) {
                currentProvider =
                    options.resolveProviderForSelection?.(result.modelProviderSelection) ?? currentProvider;
                if (result.persistModelProviderSelection === true) {
                    await options.persistModelProviderSelection?.(result.modelProviderSelection);
                }
            }
            currentModelProviderSelection = result.modelProviderSelection;
            activeTurn = result.activeTurn;
            currentSessionId = result.sessionId ?? currentSessionId;
            currentSessionStore = result.sessionStore ?? currentSessionStore;
        }
    } finally {
        unregisterProcessCleanup?.();
        activeTurn?.interrupt('force');
        chatInput.close();
    }

    return chatOutput.getOutput?.() ?? '';
}
