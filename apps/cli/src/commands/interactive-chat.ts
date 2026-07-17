// allow: SIZE_OK -- HEAD 888 -> current 930 pure LOC; one interactive chat event-loop state machine after action extraction.
import {
    type AgentRuntime,
    type AskUserQuestionRequest,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    discoverSkills,
    discoverWorkflows,
    type LocalSessionEventStore,
    type ObservabilityRedactor,
    PermissionRuleStore,
    PermissionSession,
    PluginManager,
    type ProviderAdapter,
    registerBuiltinWorkflows,
    type SdkModelResolver,
    type Skill,
    WorkflowRegistry,
} from '@mission-control/core';
import type {
    AgentEvent,
    AgentSnapshot,
    MissionControlConfig,
    ModelProviderSelection,
    WorkflowSpec,
} from '@mission-control/protocol';
import type { QuestionBatchEntry, QuestionOption } from '@mission-control/tui/chat';
import { closeTreeSitterClient } from '@mission-control/tui/highlight';
import type {
    ApprovalLevel,
    ChatAppActions,
    ChatTuiHandle,
    ChatTuiRuntimeOptions,
    DashboardAgentEntry,
    MissionPanelRow,
    ModelsOverlayRoleRow,
    SessionPickerEntry,
} from '@mission-control/tui/state';
import {
    approvalLevelRules,
    createAbgOverlayController,
    createAbgOverlayStore,
    createModelChoices,
    DEFAULT_ABG_OVERLAY_PREFS,
    loadAbgOverlayPrefs,
    type ModelChoice,
} from '@mission-control/tui/state';
import type { ProviderAuthStore } from '../auth-store';
import { getVersion } from '../cli-version';
import { toggleDisabled } from './agents-disabled-config';
import { parseModelPatternString, setOverride } from './agents-model-overrides-config';
import { parseChatLine } from './chat-commands';
import { appendInputHistoryEntry, loadInputHistoryEntries } from './input-history-store';
import type { ChatActionResult } from './interactive-chat-action-result';
import {
    type CodingActionContext,
    loadDashboardAgentEntries,
    loadMissionPanelRows,
    runChatAction,
    startWorkflowTurn,
} from './interactive-chat-actions';
import {
    type ChatInput,
    type ChatInputEvent,
    type ChatOutput,
    createTerminalChatInput,
    createTerminalChatOutput,
    maxChatPromptLength,
} from './interactive-chat-io';
import {
    areModelProviderSelectionsEqual,
    ChatInputPump,
    nextChatLoopEvent,
    registerProcessTerminalCleanup,
    stopActiveTurn,
    suspendChatInputWhileSelectingModel,
} from './interactive-chat-loop-support';
import { createTerminalModelSelector } from './interactive-chat-model-selector';
import { createSessionNavigationController } from './interactive-chat-session-navigation';
import {
    createSessionTitleWriteQueue,
    drainSessionTitleWriteQueue,
    initializeInteractiveSessionTitle,
} from './interactive-chat-session-title';
import { formatModelProviderStatus } from './interactive-chat-status';
import { createUndoRedoStack, type UndoRedoStack } from './interactive-chat-undo-redo-stack';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent';
import { interactiveSessionCliStdout } from './interactive-session-cli-stdout';
import {
    getOrCreateMissionControlServices,
    isOmoRootNotFoundError,
    type MissionControlServices,
} from './mission-control-services';
import { loadPricingTable } from './pricing-table-store';
import type { EnsuredSession } from './run-agent-session';
import { listSessionCatalogEntriesForWorkspace } from './session-catalog';
import { loadSessionTranscript } from './session-transcript-reconstruction';
import {
    detectGitBranch,
    detectGitWorktree,
    formatAppTitle,
    formatSessionTitle,
    openExternalEditor,
    resetTerminalTitle,
    setTerminalTitle,
    suppressTitleManagement,
    suspendTerminal,
} from './terminal-controls';
import { gatherWelcomeData } from './welcome-data';

export type { ChatInput, ChatInputEvent, ChatOutput };

export type ModelSelector = (
    choices: readonly ModelChoice[],
    currentSelection: ModelProviderSelection,
    options?: { readonly title?: string },
) => Promise<ModelProviderSelection | undefined>;

type AskUserRawOption = string | { readonly label: string; readonly description?: string | undefined };

function toQuestionOptions(options: readonly AskUserRawOption[]): readonly QuestionOption[] {
    return options.map((option) =>
        typeof option === 'string'
            ? { label: option }
            : {
                  label: option.label,
                  ...(option.description !== undefined ? { description: option.description } : {}),
              },
    );
}

function echoQuestionAnswer(chatOutput: ChatOutput, label: string, answer: string): void {
    if (answer.length === 0) return;
    chatOutput.write(`\ntool: You answered\n  ${label}: ${answer}\n`);
}

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
    readonly config?: MissionControlConfig;
    readonly emitEvent?: (event: AgentEvent) => void;
    readonly observeStoredEvent?: (event: AgentEvent) => void;
    readonly subscribeEvents?: (listener: (event: AgentEvent) => void) => () => void;
    readonly loadSessionSnapshot?: () => AgentSnapshot | Promise<AgentSnapshot | undefined> | undefined;
    readonly sessionStore?: LocalSessionEventStore;
    readonly switchSessionStore?: (sessionId: string) => Promise<LocalSessionEventStore>;
    readonly ensureSession?: () => Promise<EnsuredSession>;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly persistModelProviderSelection?: (selection: ModelProviderSelection) => Promise<void>;
    readonly initialApprovalLevel?: ApprovalLevel;
    readonly persistApprovalLevel?: (level: ApprovalLevel) => Promise<void>;
    /** Execution engine for coding turns. `'graph'` is the only supported value (the flat engine has
     *  been removed). `resolveSdkModel` resolves the AI-SDK model for the selection.
     */
    readonly engine?: 'graph';
    readonly resolveSdkModel?: SdkModelResolver;
    readonly authStore?: ProviderAuthStore;
    readonly profileName?: string;
    readonly plainPromptGraph?: PlainPromptGraph;
    readonly observabilityRedactor?: ObservabilityRedactor;
};

export type PlainPromptGraph = 'default-workflow' | 'coding-agent';

export async function runInteractiveChatSession(
    runtime: AgentRuntime,
    options: InteractiveChatOptions,
): Promise<string> {
    const useTui = options.input === undefined && process.stdin.isTTY === true;
    suppressTitleManagement(false);
    type SessionChatTuiRuntimeOptions = Omit<ChatTuiRuntimeOptions, 'providerID' | 'modelID' | 'variantID'> & {
        providerID: string;
        modelID: string;
        variantID?: string;
        sessionDisplayName?: string;
    };
    const initialHistoryEntries = useTui ? await loadInputHistoryEntries() : [];
    const initialAbgOverlayPrefs = useTui ? await loadAbgOverlayPrefs() : undefined;
    const pricingTableForSession = await loadPricingTable();
    const missionControlServices = await resolveMissionControlServices(
        options.workspaceRoot,
        options.observabilityRedactor,
    );
    let tuiHandleRef: ChatTuiHandle | undefined;
    const abgOverlayController = useTui
        ? createAbgOverlayController(createAbgOverlayStore(), {
              readPrefsSnapshot: () => tuiHandleRef?.getAbgOverlayPrefsSnapshot() ?? DEFAULT_ABG_OVERLAY_PREFS,
          })
        : undefined;
    // Resolve git branch + linked-worktree status once at TUI mount for the
    // StatusBar. Gated to `useTui` so the synchronous git spawn never runs on
    // the non-TUI plain/JSON paths (which pin exact output).
    const gitBranch = useTui ? detectGitBranch(options.workspaceRoot) : undefined;
    const gitWorktree = useTui ? detectGitWorktree(options.workspaceRoot) : undefined;
    const welcomeData =
        useTui && options.workspaceRoot !== undefined
            ? await gatherWelcomeData({
                  workspaceRoot: options.workspaceRoot,
                  ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
              })
            : undefined;
    const chatAppActions: ChatAppActions = {
        openExternalEditor,
        suspendTerminal,
        ...(options.workspaceRoot !== undefined
            ? {
                  loadDashboardAgentEntries,
                  loadMissionPanelRows,
                  toggleAgentDisabled: async (workspaceRoot, name, action) => {
                      await toggleDisabled({ workspaceRoot }, name, action);
                  },
                  setAgentModelOverride: async (workspaceRoot, name, value) => {
                      await setOverride({ workspaceRoot }, name, value);
                  },
                  isValidModelPattern: (raw) => parseModelPatternString(raw) !== undefined,
              }
            : {}),
    };
    const tuiRuntimeOptions: SessionChatTuiRuntimeOptions | undefined = useTui
        ? {
              providerID: options.modelProviderSelection.providerID,
              modelID: options.modelProviderSelection.modelID,
              ...(options.modelProviderSelection.variantID !== undefined
                  ? { variantID: options.modelProviderSelection.variantID }
                  : {}),
              ...(options.sessionId !== undefined ? { sessionID: options.sessionId } : {}),
              ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
              ...(gitBranch !== undefined ? { gitBranch } : {}),
              ...(gitWorktree?.isWorktree ? { isWorktree: true } : {}),
              ...(initialHistoryEntries.length > 0 ? { initialHistoryEntries } : {}),
              ...(options.initialApprovalLevel !== undefined
                  ? { initialApprovalLevel: options.initialApprovalLevel }
                  : {}),
              ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
              ...(abgOverlayController !== undefined ? { abgOverlayController } : {}),
              ...(welcomeData !== undefined ? { welcomeData } : {}),
              ...(missionControlServices !== undefined ? { missionControlServices } : {}),
              ...(options.subscribeEvents !== undefined ? { subscribeEvents: options.subscribeEvents } : {}),
              ...(options.loadSessionSnapshot !== undefined
                  ? { loadSessionSnapshot: options.loadSessionSnapshot }
                  : {}),
              actions: chatAppActions,
          }
        : undefined;
    let tuiHandle: ChatTuiHandle | undefined;
    if (useTui && tuiRuntimeOptions !== undefined) {
        const { createChatTui } = await import('@mission-control/tui/create-chat-tui');
        tuiHandle = await createChatTui(tuiRuntimeOptions);
    }
    const chatInput: ChatInput =
        options.input ??
        (tuiHandle !== undefined
            ? {
                  read: () => tuiHandle.waitForEvent(),
                  close: () => tuiHandle.unmount(),
                  suspend: () => {},
                  resume: () => {},
                  controlsPrompt: true,
                  renderPrompt: () => {},
              }
            : createTerminalChatInput());
    const baseChatOutput: ChatOutput =
        options.output ??
        (tuiHandle !== undefined
            ? {
                  write: (text) => tuiHandle.emitOutput(text),
                  getOutput: () => tuiHandle.getOutput(),
                  setAgentStatus: (text) => tuiHandle.setAgentStatus(text),
                  clearAgentStatus: () => tuiHandle.clearAgentStatus(),
                  showNotice: (text) => tuiHandle.showTransientNotice(text),
                  isShowThinking: () => tuiHandle.isShowThinking(),
                  isToolOutputExpanded: () => tuiHandle.isToolOutputExpanded(),
                  showApproval: (toolName, action) => tuiHandle.showApproval(toolName, action),
                  hideApproval: () => tuiHandle.hideApproval(),
              }
            : createTerminalChatOutput());
    // Mirror of the conversation text for /undo and /redo. This is display-only;
    // the durable session store is never modified by undo/redo.
    let conversationText = '';
    let undoRedoStack = createUndoRedoStack();
    const chatOutput: ChatOutput = {
        ...baseChatOutput,
        write: (text: string) => {
            conversationText += text;
            baseChatOutput.write(text);
        },
    };
    const showExitHint = (message: string): void => {
        if (chatOutput.showNotice !== undefined) {
            chatOutput.showNotice(message);
        } else {
            chatOutput.write(`\n${message}\n`);
        }
    };
    const undoRedoController = {
        // The TUI handle echoes "You: ..." directly to its store, bypassing the
        // conversationText mirror; prefer the TUI's full text when present.
        readOutputText: () => tuiHandle?.getOutput() ?? conversationText,
        replaceOutputText: (next: string) => {
            conversationText = next;
            tuiHandle?.replaceOutputText(next);
        },
        getStack: () => undoRedoStack,
        setStack: (next: UndoRedoStack) => {
            undoRedoStack = next;
        },
    };
    const selectModel: ModelSelector =
        tuiHandle !== undefined
            ? (choices) => tuiHandle.showModelPicker(choices)
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
    let lastCodingContext: CodingActionContext | undefined;
    let turnCounter = 0;
    const inputPump = new ChatInputPump(chatInput);
    let currentSessionId = options.sessionId;
    tuiHandle?.setSessionId(currentSessionId ?? '');
    let currentProvider = options.resolveProviderForSelection?.(currentModelProviderSelection) ?? options.provider;
    let currentSessionStore = options.sessionStore;
    let currentApprovalLevel: ApprovalLevel | undefined = options.initialApprovalLevel;

    // Seed the interactive turn counter from the durable session store so resumed or switched
    // sessions never reuse an already-promoted input_turn_interactive_N id. Without this, the
    // counter starts at 0 on every process restart, and the first new prompt collides with a
    // prior prompt.promoted event → SessionAdmissionError('input_conflict').
    const seedTurnCounterFromStore = async (
        store: LocalSessionEventStore | undefined,
        sessionId: string | undefined,
    ): Promise<void> => {
        if (store === undefined || sessionId === undefined) {
            return;
        }
        const events = await store.getEvents(sessionId);
        let maxSuffix = 0;
        for (const event of events) {
            const inputId = event.transcript?.inputId;
            if (typeof inputId !== 'string') {
                continue;
            }
            const match = inputId.match(/^input_turn_interactive_(\d+)$/u);
            if (match?.[1] !== undefined) {
                maxSuffix = Math.max(maxSuffix, Number.parseInt(match[1], 10));
            }
        }
        turnCounter = Math.max(turnCounter, maxSuffix);
    };
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
            if (tuiRuntimeOptions !== undefined) {
                tuiRuntimeOptions.sessionDisplayName = name;
            }
        },
    };
    const switchSessionStore = options.switchSessionStore;
    let manualRenameRevision = 0;
    const enqueueSessionTitleWrite = createSessionTitleWriteQueue();
    const titleGenerationAbortController = new AbortController();
    const titleGenerationTasks = new Set<Promise<void>>();
    const invalidateTitleGeneration = (): void => {
        manualRenameRevision += 1;
        titleGenerationAbortController.abort();
    };
    const registerTitleGenerationTask = (task: Promise<void>): void => {
        const settledTask = task.then(
            () => undefined,
            () => undefined,
        );
        titleGenerationTasks.add(settledTask);
        void settledTask.then(() => {
            titleGenerationTasks.delete(settledTask);
        });
    };
    const sessionNavigation =
        switchSessionStore === undefined
            ? undefined
            : createSessionNavigationController({
                  getCurrentSessionId: () => (currentSessionStore === undefined ? undefined : currentSessionId),
                  getCurrentStore: () => currentSessionStore,
                  switchSessionStore: async (sessionId) => {
                      invalidateTitleGeneration();
                      await drainSessionTitleWriteQueue(enqueueSessionTitleWrite);
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
    const unregisterProcessCleanup = tuiHandle === undefined ? registerProcessTerminalCleanup(chatInput) : undefined;

    const syncSessionDisplayName = async (sessionId: string | undefined): Promise<void> => {
        const sid = sessionId ?? '';
        if (sid.length === 0) {
            sessionDisplayNameController.update('');
            tuiHandle?.setSessionDisplayName(undefined);
            setTerminalTitle(formatAppTitle(getVersion()));
            return;
        }
        let name: string | undefined;
        try {
            if (options.workspaceRoot !== undefined) {
                const entries = await listSessionCatalogEntriesForWorkspace(
                    options.workspaceRoot,
                    options.observabilityRedactor,
                );
                const entry = entries.find((it) => it.sessionId === sid);
                name = entry?.name;
            }
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            // best-effort: leave name undefined on catalog read failure
        }
        sessionDisplayNameController.update(name ?? '');
        tuiHandle?.setSessionDisplayName(name);
        setTerminalTitle(formatSessionTitle(sid, name));
    };

    const applySessionRenameEffects = async (name: string): Promise<void> => {
        const targetSessionId = currentSessionId;
        const targetModelProviderSelection = currentModelProviderSelection;
        tuiHandle?.setSessionDisplayName(name);
        setTerminalTitle(formatSessionTitle(targetSessionId, name));
        if (sessionNavigation !== undefined && targetSessionId !== undefined) {
            try {
                await enqueueSessionTitleWrite(async () => {
                    if (currentSessionId !== targetSessionId) return;
                    await sessionNavigation.renameSession({
                        name,
                        modelProviderSelection: targetModelProviderSelection,
                    });
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                chatOutput.write(`Could not persist session rename: ${message}\n`);
            }
        }
    };
    const applyManualSessionRename = async (name: string): Promise<void> => {
        invalidateTitleGeneration();
        await applySessionRenameEffects(name);
    };

    if (tuiHandle === undefined) {
        setTerminalTitle(formatAppTitle(getVersion()));
        void syncSessionDisplayName(currentSessionId);
    } else {
        setTimeout(() => {
            setTerminalTitle(formatAppTitle(getVersion()));
            void syncSessionDisplayName(currentSessionId);
        }, 0);
    }

    if (tuiHandle !== undefined) {
        tuiHandleRef = tuiHandle;
        if (initialAbgOverlayPrefs !== undefined) {
            tuiHandle.applyAbgOverlayPrefs(initialAbgOverlayPrefs);
        }
        tuiHandle.setModelCycleChoices(modelChoices);
        tuiHandle.onModelCycleSelect = (selection) => {
            currentModelProviderSelection = selection;
            currentProvider = options.resolveProviderForSelection?.(selection) ?? currentProvider;
            if (tuiRuntimeOptions !== undefined) {
                tuiRuntimeOptions.providerID = selection.providerID;
                tuiRuntimeOptions.modelID = selection.modelID;
                if (selection.variantID !== undefined) {
                    tuiRuntimeOptions.variantID = selection.variantID;
                } else {
                    delete tuiRuntimeOptions.variantID;
                }
            }
        };
        tuiHandle.onRenameSubmit = (name: string) => {
            sessionDisplayNameController.update(name);
            void applyManualSessionRename(name).then(
                () => undefined,
                () => undefined,
            );
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
            if (!useTui) {
                process.stderr.write(
                    `plugin discovery [${diagnostic.severity}] ${diagnostic.pluginName}: ${diagnostic.message}\n`,
                );
            }
        }
    } catch (error: unknown) {
        if (!useTui) {
            process.stderr.write(
                `plugin discovery [warning] skipped: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
    }

    const discoveredSkills =
        options.workspaceRoot !== undefined
            ? await discoverSkills({
                  workspaceRoot: options.workspaceRoot,
                  ...(pluginSkillDirs.length > 0 ? { additionalSkillDirs: pluginSkillDirs } : {}),
              })
            : { skills: [], diagnostics: [] };
    let sessionSkills: readonly Skill[] = discoveredSkills.skills;
    tuiHandle?.setSkillNames(sessionSkills.map((skill) => skill.name));

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
    tuiHandle?.setWorkflowNames(sessionWorkflowRegistry.names());
    const pendingWorkflowTurns: Array<{ readonly spec: WorkflowSpec; readonly prompt: string }> = [];
    let workflowChainDepth = 0;
    const MAX_CHAINED_WORKFLOW_TURNS = 4;
    const onWorkflowStarted = (spec: WorkflowSpec, prompt: string): void => {
        pendingWorkflowTurns.push({ spec, prompt });
    };
    if (!useTui) {
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

        // Best-effort: load the prior conversation so it's visible on resume. A missing or
        // corrupt log leaves the transcript blank and resume still proceeds.
        if (currentSessionId !== undefined) {
            const resumedTranscript = await loadSessionTranscript(currentSessionId, options.observabilityRedactor);
            if (resumedTranscript.length > 0) {
                if (tuiHandle !== undefined) {
                    tuiHandle.replaceOutputText(resumedTranscript);
                } else {
                    chatOutput.write(resumedTranscript);
                }
            }
        }

        await seedTurnCounterFromStore(currentSessionStore, currentSessionId);

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
                if (
                    next.outcome === 'completed' &&
                    lastCodingContext !== undefined &&
                    pendingWorkflowTurns.length > 0 &&
                    workflowChainDepth < MAX_CHAINED_WORKFLOW_TURNS
                ) {
                    const pending = pendingWorkflowTurns.shift();
                    if (pending !== undefined) {
                        workflowChainDepth += 1;
                        const workflowResult = await startWorkflowTurn(
                            runtime,
                            chatOutput,
                            pending.spec,
                            pending.prompt,
                            currentModelProviderSelection,
                            lastCodingContext,
                        );
                        activeTurn = workflowResult.activeTurn;
                        continue;
                    }
                }
                workflowChainDepth = 0;
                pendingWorkflowTurns.length = 0;
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
                    workflowChainDepth = 0;
                    pendingWorkflowTurns.length = 0;
                    pendingInterrupt = false;
                    showExitHint('Press Ctrl+C twice to exit');
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
                showExitHint('Press Ctrl+C again to exit');
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

            const action = parseChatLine(event.value, {
                modelChoices,
                knownWorkflowNames,
                ...(currentSessionId !== undefined ? { currentSessionId } : {}),
            });
            if (action.kind === 'exit') {
                activeTurn = await stopActiveTurn(activeTurn);
                chatOutput.write('Exiting mission-control chat\n');
                break;
            }
            if (
                currentSessionId === undefined &&
                options.ensureSession !== undefined &&
                (action.kind === 'prompt' ||
                    action.kind === 'skill' ||
                    action.kind === 'workflow' ||
                    action.kind === 'bash')
            ) {
                const ensured = await options.ensureSession();
                currentSessionId = ensured.sessionId;
                currentSessionStore = ensured.store;
                tuiHandle?.setSessionId(currentSessionId);
                const titleNavigation = sessionNavigation;
                if (action.kind === 'prompt' && titleNavigation !== undefined) {
                    await initializeInteractiveSessionTitle({
                        sessionId: currentSessionId,
                        prompt: action.prompt,
                        state: {
                            snapshot: () => ({
                                sessionId: currentSessionId,
                                displayName: sessionDisplayNameController.current(),
                                manualRenameRevision,
                            }),
                            displayTitle: (title) => {
                                sessionDisplayNameController.update(title);
                                tuiHandle?.setSessionDisplayName(title);
                                setTerminalTitle(formatSessionTitle(currentSessionId, title));
                            },
                            persistTitle: async (title) => {
                                await titleNavigation.renameSession({
                                    name: title,
                                    modelProviderSelection: currentModelProviderSelection,
                                });
                            },
                            enqueueWrite: enqueueSessionTitleWrite,
                        },
                        model: {
                            activeSelection: currentModelProviderSelection,
                            ...(currentProvider !== undefined ? { activeProvider: currentProvider } : {}),
                            ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
                            ...(options.resolveProviderForSelection !== undefined
                                ? { resolveProviderForSelection: options.resolveProviderForSelection }
                                : {}),
                        },
                        signal: titleGenerationAbortController.signal,
                        registerBackgroundTask: registerTitleGenerationTask,
                    });
                } else {
                    void syncSessionDisplayName(currentSessionId);
                }
            }
            let result: ChatActionResult;
            const isPickerAction =
                action.kind === 'sessions' || action.kind === 'session-picker' || action.kind === 'agents';
            if (tuiHandle !== undefined && !isPickerAction) {
                tuiHandle.setGenerating(true);
            }
            try {
                const codingContext: CodingActionContext = {
                    activeTurn,
                    useTui,
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
                    ...(options.config !== undefined ? { config: options.config } : {}),
                    skills: sessionSkills,
                    onSkillsReloaded: (skills) => {
                        sessionSkills = skills;
                        tuiHandle?.setSkillNames(skills.map((skill) => skill.name));
                    },
                    workflowRegistry: sessionWorkflowRegistry,
                    onWorkflowStarted,
                    ...(options.plainPromptGraph !== undefined ? { plainPromptGraph: options.plainPromptGraph } : {}),
                    sessionDisplayName: sessionDisplayNameController,
                    onSessionRenamed: applyManualSessionRename,
                    undoRedo: undoRedoController,
                    ...(sessionNavigation !== undefined ? { sessionNavigation } : {}),
                    ...(options.engine !== undefined ? { engine: options.engine } : {}),
                    ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
                    ...(abgOverlayController !== undefined ? { abgOverlayController } : {}),
                    ...(pricingTableForSession.length > 0 ? { pricingTable: pricingTableForSession } : {}),
                    ...(currentApprovalLevel !== undefined ? { approvalLevel: currentApprovalLevel } : {}),
                    permissionSession: sharedPermissionSession,
                    ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
                    ...(missionControlServices !== undefined
                        ? { taskRuntimeServices: missionControlServices.getTaskRuntimeServices() }
                        : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              onUsage: (inputTokens: number | undefined) => tuiHandle.setContextTokensUsed(inputTokens),
                          }
                        : {}),
                    listWorkspaceSessions: async () => {
                        if (options.workspaceRoot === undefined) return [];
                        const entries = await listSessionCatalogEntriesForWorkspace(
                            options.workspaceRoot,
                            options.observabilityRedactor,
                        );
                        return entries.map((entry) => ({
                            sessionId: entry.sessionId,
                            label: entry.name ?? entry.sessionId,
                            ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
                            messageCount: entry.messageCount,
                            status: entry.status,
                        }));
                    },
                    ...(tuiHandle !== undefined
                        ? {
                              selectSessionForAttach: (entries: readonly SessionPickerEntry[]) =>
                                  tuiHandle.showSessionPicker(entries),
                          }
                        : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              openAgentsDashboard: (entries: readonly DashboardAgentEntry[]) =>
                                  tuiHandle.showAgentsDashboard(entries),
                          }
                        : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              reloadAgentsDashboard: (entries: readonly DashboardAgentEntry[]) =>
                                  tuiHandle.reloadAgentsDashboard(entries),
                          }
                        : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              openMissionPanel: (rows: readonly MissionPanelRow[]) => tuiHandle.showMissionPanel(rows),
                          }
                        : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              reloadMissionPanel: (rows: readonly MissionPanelRow[]) => tuiHandle.reloadMissions(rows),
                          }
                        : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              openModelsOverlay: (
                                  entries: readonly ModelProviderSelection[],
                                  roleRows: readonly ModelsOverlayRoleRow[],
                              ) => tuiHandle.showModelsOverlay(entries, roleRows),
                          }
                        : {}),
                    ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
                    ...(options.observabilityRedactor !== undefined
                        ? { observabilityRedactor: options.observabilityRedactor }
                        : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              selectApprovalLevel: (currentLevel?: ApprovalLevel) =>
                                  tuiHandle
                                      .showLevelPicker(currentLevel)
                                      .then((level): ApprovalLevel | undefined =>
                                          level !== undefined ? (level as ApprovalLevel) : undefined,
                                      ),
                          }
                        : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              requestUserQuestion: async (request: AskUserQuestionRequest) => {
                                  const answer = await tuiHandle.showQuestion(
                                      request.question,
                                      toQuestionOptions(request.options),
                                      {
                                          ...(request.header !== undefined ? { header: request.header } : {}),
                                          ...(request.multiple !== undefined ? { multiple: request.multiple } : {}),
                                      },
                                  );
                                  echoQuestionAnswer(chatOutput, request.header ?? request.question, answer);
                                  return answer;
                              },
                              requestUserQuestions: async (requests: readonly AskUserQuestionRequest[]) => {
                                  const entries: readonly QuestionBatchEntry[] = requests.map((request) => ({
                                      question: request.question,
                                      header: request.header ?? '',
                                      options: toQuestionOptions(request.options),
                                      multiple: request.multiple ?? false,
                                  }));
                                  const answers = await tuiHandle.showQuestionBatch(entries);
                                  const lines = requests.map(
                                      (request, i) => `  ${request.header ?? request.question}: ${answers[i] ?? ''}`,
                                  );
                                  const count = requests.length;
                                  chatOutput.write(
                                      `\ntool: Answered ${count} question${count > 1 ? 's' : ''}\n${lines.join('\n')}\n`,
                                  );
                                  return answers;
                              },
                          }
                        : {}),
                };
                lastCodingContext = codingContext;
                result = await runChatAction(
                    runtime,
                    chatOutput,
                    action,
                    currentModelProviderSelection,
                    selectModel,
                    modelChoices,
                    codingContext,
                );
                if (action.kind === 'interrupt') {
                    workflowChainDepth = 0;
                    pendingWorkflowTurns.length = 0;
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                chatOutput.write(`Error: ${message}\n`);
                if (tuiHandle !== undefined) {
                    tuiHandle.setGenerating(false);
                }
                continue;
            }
            if (tuiHandle !== undefined) {
                tuiHandle.setGenerating(false);
            }
            if (!areModelProviderSelectionsEqual(currentModelProviderSelection, result.modelProviderSelection)) {
                currentProvider =
                    options.resolveProviderForSelection?.(result.modelProviderSelection) ?? currentProvider;
                if (result.persistModelProviderSelection === true) {
                    await options.persistModelProviderSelection?.(result.modelProviderSelection);
                }
                // Sync store so Ctrl+V variant cycling targets the new base.
                tuiHandle?.setModelSelection(result.modelProviderSelection);
            }
            currentModelProviderSelection = result.modelProviderSelection;
            activeTurn = result.activeTurn;
            if (result.sessionId !== undefined && result.sessionId !== currentSessionId) {
                invalidateTitleGeneration();
                await drainSessionTitleWriteQueue(enqueueSessionTitleWrite);
            }
            currentSessionId = result.sessionId ?? currentSessionId;
            tuiHandle?.setSessionId(currentSessionId ?? '');
            if (result.sessionId !== undefined) {
                void syncSessionDisplayName(result.sessionId);
            }
            currentSessionStore = result.sessionStore ?? currentSessionStore;
            if (result.sessionStore !== undefined && result.sessionId !== undefined) {
                await seedTurnCounterFromStore(result.sessionStore, result.sessionId);
            }
            if (result.approvalLevel !== undefined) {
                currentApprovalLevel = result.approvalLevel;
                sharedPermissionSession.replaceBuiltInRules(approvalLevelRules(currentApprovalLevel));
                tuiHandle?.setApprovalLevel(currentApprovalLevel);
                await options.persistApprovalLevel?.(currentApprovalLevel);
            }
        }
    } finally {
        unregisterProcessCleanup?.();
        activeTurn?.interrupt('force');
        titleGenerationAbortController.abort();
        await Promise.all(titleGenerationTasks);
        await drainSessionTitleWriteQueue(enqueueSessionTitleWrite);
        abgOverlayController?.reset();
        chatInput.close();
        resetTerminalTitle();
        await missionControlServices?.dispose();
        await closeTreeSitterClient();
    }

    return interactiveSessionCliStdout({
        tuiOwnedDisplay: tuiHandle !== undefined && options.output === undefined,
        ...(chatOutput.getOutput !== undefined ? { getOutput: () => chatOutput.getOutput?.() ?? '' } : {}),
    });
}

async function resolveMissionControlServices(
    workspaceRoot: string | undefined,
    observabilityRedactor: ObservabilityRedactor | undefined,
): Promise<MissionControlServices | undefined> {
    if (workspaceRoot === undefined) return undefined;
    try {
        return await getOrCreateMissionControlServices(workspaceRoot, {
            ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
        });
    } catch (error: unknown) {
        if (isOmoRootNotFoundError(error)) {
            return undefined;
        }
        throw error;
    }
}
