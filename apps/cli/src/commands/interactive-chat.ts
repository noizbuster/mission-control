import {
    type AgentRuntime,
    type AskUserQuestionRequest,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    discoverSkills,
    discoverWorkflows,
    type JsonlSessionEventStore,
    PermissionRuleStore,
    PermissionSession,
    PluginManager,
    type ProviderAdapter,
    registerBuiltinWorkflows,
    type SdkModelResolver,
    type Skill,
    WorkflowRegistry,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { closeTreeSitterClient } from '../components/markdown/highlight.js';
import { createAbgOverlayController } from './abg-overlay-controller.js';
import { DEFAULT_ABG_OVERLAY_PREFS, loadAbgOverlayPrefs } from './abg-overlay-prefs-store.js';
import { createAbgOverlayStore } from './abg-overlay-state.js';
import type { ApprovalLevel } from './approval-level.js';
import { approvalLevelRules } from './approval-level.js';
import { parseChatLine } from './chat-commands.js';
import { appendInputHistoryEntry, loadInputHistoryEntries } from './input-history-store.js';
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
import { createChatTui, type ChatTuiOptions } from './create-chat-tui.js';
import type { OpenTuiChatBridge, OpenTuiChatBridgeOptions } from './chat-tui-types.js';
import { loadPricingTable } from './pricing-table-store.js';

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
    readonly initialApprovalLevel?: ApprovalLevel;
    readonly persistApprovalLevel?: (level: ApprovalLevel) => Promise<void>;
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
    const useTui = options.input === undefined && process.stdin.isTTY === true;
    type SessionBridgeOptions = Omit<OpenTuiChatBridgeOptions, 'providerID' | 'modelID' | 'variantID'> & {
        providerID: string;
        modelID: string;
        variantID?: string;
        sessionDisplayName?: string;
    };
    const initialHistoryEntries = useTui ? await loadInputHistoryEntries() : [];
    const initialAbgOverlayPrefs = useTui ? await loadAbgOverlayPrefs() : undefined;
    const pricingTableForSession = await loadPricingTable();
    let tuiBridgeRef: OpenTuiChatBridge | undefined;
    const abgOverlayController = useTui
        ? createAbgOverlayController(createAbgOverlayStore(), {
              readPrefsSnapshot: () => tuiBridgeRef?.getAbgOverlayPrefsSnapshot() ?? DEFAULT_ABG_OVERLAY_PREFS,
          })
        : undefined;
    const bridgeOptions: SessionBridgeOptions | undefined = useTui
        ? {
              providerID: options.modelProviderSelection.providerID,
              modelID: options.modelProviderSelection.modelID,
              ...(options.modelProviderSelection.variantID !== undefined
                  ? { variantID: options.modelProviderSelection.variantID }
                  : {}),
              ...(options.sessionId !== undefined ? { sessionID: options.sessionId } : {}),
              ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
              ...(initialHistoryEntries.length > 0 ? { initialHistoryEntries } : {}),
              ...(options.initialApprovalLevel !== undefined
                  ? { initialApprovalLevel: options.initialApprovalLevel }
                  : {}),
              ...(abgOverlayController !== undefined ? { abgOverlayController } : {}),
          }
        : undefined;
    const tuiBridge =
        useTui && bridgeOptions !== undefined ? await createChatTui(bridgeOptions as ChatTuiOptions) : undefined;
    const chatInput: ChatInput =
        options.input ??
        (tuiBridge !== undefined
            ? {
                  read: () => tuiBridge.waitForEvent(),
                  close: () => tuiBridge.unmount(),
                  suspend: () => {},
                  resume: () => {},
                  controlsPrompt: true,
                  renderPrompt: () => {},
              }
            : createTerminalChatInput());
    const baseChatOutput: ChatOutput =
        options.output ??
        (tuiBridge !== undefined
            ? {
                  write: (text) => tuiBridge.emitOutput(text),
                  getOutput: () => tuiBridge.getOutput(),
                  setAgentStatus: (text) => tuiBridge.setAgentStatus(text),
                  clearAgentStatus: () => tuiBridge.clearAgentStatus(),
                  isShowThinking: () => tuiBridge.isShowThinking(),
                  isToolOutputExpanded: () => tuiBridge.isToolOutputExpanded(),
                  showApproval: (toolName, action) => tuiBridge.showApproval(toolName, action),
                  hideApproval: () => tuiBridge.hideApproval(),
              }
            : createTerminalChatOutput());
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
        readOutputText: () => tuiBridge?.getOutput() ?? conversationText,
        replaceOutputText: (next: string) => {
            conversationText = next;
            tuiBridge?.replaceOutputText(next);
        },
        getStack: () => undoRedoStack,
        setStack: (next: UndoRedoStack) => {
            undoRedoStack = next;
        },
    };
    const selectModel: ModelSelector =
        tuiBridge !== undefined
            ? (choices) => tuiBridge.showModelPicker(choices)
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
    let currentApprovalLevel: ApprovalLevel | undefined = options.initialApprovalLevel;
    // Shared across turns so session-scoped "always" approvals and the active level survive turn boundaries.
    const sharedPermissionSession = new PermissionSession({
        builtInRules: approvalLevelRules(currentApprovalLevel ?? 'safe'),
        persistedRuleStore: new PermissionRuleStore(),
    });
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
    const unregisterProcessCleanup = tuiBridge === undefined ? registerProcessTerminalCleanup(chatInput) : undefined;

    if (tuiBridge !== undefined) {
        tuiBridgeRef = tuiBridge;
        if (initialAbgOverlayPrefs !== undefined) {
            tuiBridge.applyAbgOverlayPrefs(initialAbgOverlayPrefs);
        }
        tuiBridge.setModelCycleChoices(modelChoices);
        tuiBridge.onModelCycleSelect = (selection) => {
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
        tuiBridge.onRenameSubmit = (name: string) => {
            sessionDisplayNameController.update(name);
        };
    }

    const pluginManager = new PluginManager(
        options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {},
    );
    const pluginSkillDirs: string[] = [];
    const pluginWorkflowDirs: string[] = [];
    try {
        await pluginManager.initialize();
        pluginSkillDirs.push(...pluginManager.getSkillDirs());
        pluginWorkflowDirs.push(...pluginManager.getWorkflowDirs());
        for (const diagnostic of pluginManager.getDiagnostics()) {
            process.stderr.write(
                `plugin discovery [${diagnostic.severity}] ${diagnostic.pluginName}: ${diagnostic.message}\n`,
            );
        }
    } catch (error: unknown) {
        process.stderr.write(
            `plugin discovery [warning] skipped: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }

    const discoveredSkills =
        options.workspaceRoot !== undefined
            ? await discoverSkills({
                  workspaceRoot: options.workspaceRoot,
                  ...(pluginSkillDirs.length > 0 ? { additionalSkillDirs: pluginSkillDirs } : {}),
              })
            : { skills: [], diagnostics: [] };
    const knownSkillNames = new Set<string>(discoveredSkills.skills.map((skill) => skill.name));
    const sessionSkills: readonly Skill[] = discoveredSkills.skills;

    const discoveredWorkflows =
        options.workspaceRoot !== undefined
            ? await discoverWorkflows({
                  workspaceRoot: options.workspaceRoot,
                  ...(pluginWorkflowDirs.length > 0 ? { additionalWorkflowDirs: pluginWorkflowDirs } : {}),
              })
            : { workflows: [], diagnostics: [] };
    const sessionWorkflowRegistry = new WorkflowRegistry(discoveredWorkflows.workflows);
    registerBuiltinWorkflows(sessionWorkflowRegistry);
    await pluginManager.registerInto(sessionWorkflowRegistry);
    const knownWorkflowNames = new Set<string>(sessionWorkflowRegistry.names());
    tuiBridge?.setWorkflowNames(sessionWorkflowRegistry.names());
    if (discoveredWorkflows.diagnostics.length > 0) {
        for (const diagnostic of discoveredWorkflows.diagnostics) {
            process.stderr.write(
                `workflow discovery [${diagnostic.severity}] ${diagnostic.workflowName}: ${diagnostic.message}\n`,
            );
        }
    }

    try {
        if (!useTui) {
            chatOutput.write('mission-control chat\n');
            chatOutput.write(formatModelProviderStatus(currentModelProviderSelection, { nodeMode: 'none' }));
            if (currentSessionId !== undefined && currentSessionStore !== undefined) {
                chatOutput.write(`resumed session: ${currentSessionId}\n`);
            }
            chatOutput.write('Press Ctrl+C twice or /exit to exit\n\n');
        }

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
                // ESC-sourced interrupts are stop-only: they never count
                // toward the "press twice to exit" exit path that Ctrl+C owns.
                if (event.source === 'esc') {
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
            await appendInputHistoryEntry(prompt);
            if (prompt.length > maxChatPromptLength) {
                chatOutput.write(`Prompt is too long (max ${maxChatPromptLength} characters).\n`);
                continue;
            }

            const action = parseChatLine(prompt, {
                modelChoices,
                knownSkillNames,
                knownWorkflowNames,
                ...(currentSessionId !== undefined ? { currentSessionId } : {}),
            });
            if (action.kind === 'exit') {
                activeTurn = await stopActiveTurn(activeTurn);
                chatOutput.write('Exiting mission-control chat\n');
                break;
            }
            let result: ChatActionResult;
            if (tuiBridge !== undefined) {
                tuiBridge.setGenerating(true);
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
                        workflowRegistry: sessionWorkflowRegistry,
                        sessionDisplayName: sessionDisplayNameController,
                        undoRedo: undoRedoController,
                        ...(sessionNavigation !== undefined ? { sessionNavigation } : {}),
                        ...(options.engine !== undefined ? { engine: options.engine } : {}),
                        ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
                        ...(abgOverlayController !== undefined ? { abgOverlayController } : {}),
                        ...(pricingTableForSession.length > 0 ? { pricingTable: pricingTableForSession } : {}),
                        ...(currentApprovalLevel !== undefined ? { approvalLevel: currentApprovalLevel } : {}),
                        permissionSession: sharedPermissionSession,
                        ...(tuiBridge !== undefined
                            ? {
                                  selectApprovalLevel: (currentLevel?: ApprovalLevel) =>
                                      tuiBridge
                                          .showLevelPicker(currentLevel)
                                          .then((level): ApprovalLevel | undefined =>
                                              level !== undefined ? (level as ApprovalLevel) : undefined,
                                          ),
                              }
                            : {}),
                        ...(tuiBridge !== undefined
                            ? {
                                  requestUserQuestion: (request: AskUserQuestionRequest) =>
                                      tuiBridge.showQuestion(
                                          request.question,
                                          request.options.map((option) =>
                                              typeof option === 'string'
                                                  ? option
                                                  : {
                                                        label: option.label,
                                                        ...(option.description !== undefined
                                                            ? { description: option.description }
                                                            : {}),
                                                    },
                                          ),
                                          {
                                              ...(request.header !== undefined ? { header: request.header } : {}),
                                              ...(request.multiple !== undefined ? { multiple: request.multiple } : {}),
                                          },
                                      ),
                              }
                            : {}),
                    },
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                chatOutput.write(`Error: ${message}\n`);
                if (tuiBridge !== undefined) {
                    tuiBridge.setGenerating(false);
                }
                continue;
            }
            if (tuiBridge !== undefined) {
                tuiBridge.setGenerating(false);
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
            if (result.approvalLevel !== undefined) {
                currentApprovalLevel = result.approvalLevel;
                sharedPermissionSession.replaceBuiltInRules(approvalLevelRules(currentApprovalLevel));
                tuiBridge?.setApprovalLevel(currentApprovalLevel);
                await options.persistApprovalLevel?.(currentApprovalLevel);
            }
        }
    } finally {
        unregisterProcessCleanup?.();
        activeTurn?.interrupt('force');
        abgOverlayController?.reset();
        chatInput.close();
        await closeTreeSitterClient();
    }

    return chatOutput.getOutput?.() ?? '';
}
