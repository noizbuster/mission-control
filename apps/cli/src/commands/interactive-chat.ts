import {
    type AgentRuntime,
    type AskUserQuestionRequest,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    discoverSkills,
    discoverWorkflows,
    type LocalSessionEventStore,
    PermissionRuleStore,
    PermissionSession,
    PluginManager,
    type ProviderAdapter,
    registerBuiltinWorkflows,
    type SdkModelResolver,
    type Skill,
    WorkflowRegistry,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import type { ProviderAuthStore } from '../auth-store.js';
import { closeTreeSitterClient } from '../components/markdown/highlight.js';
import { getVersion } from '../index.js';
import { createAbgOverlayController } from './abg-overlay-controller.js';
import { DEFAULT_ABG_OVERLAY_PREFS, loadAbgOverlayPrefs } from './abg-overlay-prefs-store.js';
import { createAbgOverlayStore } from './abg-overlay-state.js';
import type { ApprovalLevel } from './approval-level.js';
import { approvalLevelRules } from './approval-level.js';
import { parseChatLine } from './chat-commands.js';
import type { DashboardAgentEntry, MissionPanelRow, SessionPickerEntry } from './chat-store.js';
import type { OpenTuiChatBridge, OpenTuiChatBridgeOptions } from './chat-tui-types.js';
import { type ChatTuiOptions, createChatTui } from './create-chat-tui.js';
import { appendInputHistoryEntry, loadInputHistoryEntries } from './input-history-store.js';
import type { ChatActionResult } from './interactive-chat-action-result.js';
import { type CodingActionContext, runChatAction, startWorkflowTurn } from './interactive-chat-actions.js';
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
import {
    getOrCreateMissionControlServices,
    isOmoRootNotFoundError,
    type MissionControlServices,
} from './mission-control-services.js';
import type { ModelsOverlayRoleRow } from './models-overlay-state.js';
import { loadPricingTable } from './pricing-table-store.js';
import type { QuestionBatchEntry, QuestionOption } from './question-types.js';
import type { EnsuredSession } from './run-agent-session.js';
import { listSessionCatalogEntriesForWorkspace } from './session-catalog.js';
import { loadSessionTranscript } from './session-transcript-reconstruction.js';
import {
    detectGitBranch,
    detectGitWorktree,
    formatAppTitle,
    formatSessionTitle,
    resetTerminalTitle,
    setTerminalTitle,
    suppressTitleManagement,
} from './terminal-controls.js';
import { gatherWelcomeData } from './welcome-data.js';

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
    readonly emitEvent?: (event: AgentEvent) => void;
    readonly observeStoredEvent?: (event: AgentEvent) => void;
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
};

export type PlainPromptGraph = 'default-workflow' | 'coding-agent';

export async function runInteractiveChatSession(
    runtime: AgentRuntime,
    options: InteractiveChatOptions,
): Promise<string> {
    const useTui = options.input === undefined && process.stdin.isTTY === true;
    suppressTitleManagement(useTui);
    type SessionBridgeOptions = Omit<OpenTuiChatBridgeOptions, 'providerID' | 'modelID' | 'variantID'> & {
        providerID: string;
        modelID: string;
        variantID?: string;
        sessionDisplayName?: string;
    };
    const initialHistoryEntries = useTui ? await loadInputHistoryEntries() : [];
    const initialAbgOverlayPrefs = useTui ? await loadAbgOverlayPrefs() : undefined;
    const pricingTableForSession = await loadPricingTable();
    const missionControlServices = await resolveMissionControlServices(options.workspaceRoot);
    let tuiBridgeRef: OpenTuiChatBridge | undefined;
    const abgOverlayController = useTui
        ? createAbgOverlayController(createAbgOverlayStore(), {
              readPrefsSnapshot: () => tuiBridgeRef?.getAbgOverlayPrefsSnapshot() ?? DEFAULT_ABG_OVERLAY_PREFS,
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
    const bridgeOptions: SessionBridgeOptions | undefined = useTui
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
                  showNotice: (text) => tuiBridge.showTransientNotice(text),
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
    const showExitHint = (message: string): void => {
        if (chatOutput.showNotice !== undefined) {
            chatOutput.showNotice(message);
        } else {
            chatOutput.write(`\n${message}\n`);
        }
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
    let lastCodingContext: CodingActionContext | undefined;
    let turnCounter = 0;
    const inputPump = new ChatInputPump(chatInput);
    let currentSessionId = options.sessionId;
    tuiBridge?.setSessionId(currentSessionId ?? '');
    let currentProvider = options.resolveProviderForSelection?.(currentModelProviderSelection) ?? options.provider;
    let currentSessionStore = options.sessionStore;
    let currentApprovalLevel: ApprovalLevel | undefined = options.initialApprovalLevel;

    // Seed the interactive turn counter from the durable session log so resumed or switched
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

    const syncSessionDisplayName = async (sessionId: string | undefined): Promise<void> => {
        const sid = sessionId ?? '';
        if (sid.length === 0) {
            sessionDisplayNameController.update('');
            tuiBridge?.setSessionDisplayName(undefined);
            setTerminalTitle(formatAppTitle(getVersion()));
            return;
        }
        let name: string | undefined;
        try {
            if (options.workspaceRoot !== undefined) {
                const entries = await listSessionCatalogEntriesForWorkspace(options.workspaceRoot);
                const entry = entries.find((it) => it.sessionId === sid);
                name = entry?.name;
            }
        } catch {
            // best-effort: leave name undefined on catalog read failure
        }
        sessionDisplayNameController.update(name ?? '');
        tuiBridge?.setSessionDisplayName(name);
        setTerminalTitle(formatSessionTitle(sid, name));
    };

    const applySessionRenameEffects = async (name: string): Promise<void> => {
        tuiBridge?.setSessionDisplayName(name);
        setTerminalTitle(formatSessionTitle(currentSessionId, name));
        if (sessionNavigation !== undefined && currentSessionId !== undefined) {
            try {
                await sessionNavigation.renameSession({
                    name,
                    modelProviderSelection: currentModelProviderSelection,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                chatOutput.write(`Could not persist session rename: ${message}\n`);
            }
        }
    };

    setTerminalTitle(formatAppTitle(getVersion()));
    void syncSessionDisplayName(currentSessionId);

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
            void applySessionRenameEffects(name);
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
            const resumedTranscript = await loadSessionTranscript(currentSessionId);
            if (resumedTranscript.length > 0) {
                if (tuiBridge !== undefined) {
                    tuiBridge.replaceOutputText(resumedTranscript);
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
                    lastCodingContext !== undefined &&
                    pendingWorkflowTurns.length > 0 &&
                    workflowChainDepth < MAX_CHAINED_WORKFLOW_TURNS
                ) {
                    const pending = pendingWorkflowTurns.shift()!;
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
                tuiBridge?.setSessionId(currentSessionId);
                void syncSessionDisplayName(currentSessionId);
                currentSessionStore = ensured.store;
            }
            let result: ChatActionResult;
            const isPickerAction =
                action.kind === 'sessions' || action.kind === 'session-picker' || action.kind === 'agents';
            if (tuiBridge !== undefined && !isPickerAction) {
                tuiBridge.setGenerating(true);
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
                    skills: sessionSkills,
                    workflowRegistry: sessionWorkflowRegistry,
                    onWorkflowStarted,
                    ...(options.plainPromptGraph !== undefined ? { plainPromptGraph: options.plainPromptGraph } : {}),
                    sessionDisplayName: sessionDisplayNameController,
                    onSessionRenamed: applySessionRenameEffects,
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
                    ...(tuiBridge !== undefined
                        ? {
                              onUsage: (inputTokens: number | undefined) => tuiBridge.setContextTokensUsed(inputTokens),
                          }
                        : {}),
                    listWorkspaceSessions: async () => {
                        if (options.workspaceRoot === undefined) return [];
                        const entries = await listSessionCatalogEntriesForWorkspace(options.workspaceRoot);
                        return entries.map((entry) => ({
                            sessionId: entry.sessionId,
                            label: entry.name ?? entry.sessionId,
                            ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
                            messageCount: entry.messageCount,
                            status: entry.status,
                        }));
                    },
                    ...(tuiBridge !== undefined
                        ? {
                              selectSessionForAttach: (entries: readonly SessionPickerEntry[]) =>
                                  tuiBridge.showSessionPicker(entries),
                          }
                        : {}),
                    ...(tuiBridge !== undefined
                        ? {
                              openAgentsDashboard: (entries: readonly DashboardAgentEntry[]) =>
                                  tuiBridge.showAgentsDashboard(entries),
                          }
                        : {}),
                    ...(tuiBridge !== undefined
                        ? {
                              reloadAgentsDashboard: (entries: readonly DashboardAgentEntry[]) =>
                                  tuiBridge.reloadAgentsDashboard(entries),
                          }
                        : {}),
                    ...(tuiBridge !== undefined
                        ? {
                              openMissionPanel: (rows: readonly MissionPanelRow[]) => tuiBridge.showMissionPanel(rows),
                          }
                        : {}),
                    ...(tuiBridge !== undefined
                        ? {
                              reloadMissionPanel: (rows: readonly MissionPanelRow[]) => tuiBridge.reloadMissions(rows),
                          }
                        : {}),
                    ...(tuiBridge !== undefined
                        ? {
                              openModelsOverlay: (
                                  entries: readonly ModelProviderSelection[],
                                  roleRows: readonly ModelsOverlayRoleRow[],
                              ) => tuiBridge.showModelsOverlay(entries, roleRows),
                          }
                        : {}),
                    ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
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
                              requestUserQuestion: async (request: AskUserQuestionRequest) => {
                                  const answer = await tuiBridge.showQuestion(
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
                                  const answers = await tuiBridge.showQuestionBatch(entries);
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
                // Sync store so Ctrl+V variant cycling targets the new base.
                tuiBridge?.setModelSelection(result.modelProviderSelection);
            }
            currentModelProviderSelection = result.modelProviderSelection;
            activeTurn = result.activeTurn;
            currentSessionId = result.sessionId ?? currentSessionId;
            tuiBridge?.setSessionId(currentSessionId ?? '');
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
                tuiBridge?.setApprovalLevel(currentApprovalLevel);
                await options.persistApprovalLevel?.(currentApprovalLevel);
            }
        }
    } finally {
        unregisterProcessCleanup?.();
        activeTurn?.interrupt('force');
        abgOverlayController?.reset();
        chatInput.close();
        resetTerminalTitle();
        await missionControlServices?.dispose();
        await closeTreeSitterClient();
    }

    return chatOutput.getOutput?.() ?? '';
}

async function resolveMissionControlServices(
    workspaceRoot: string | undefined,
): Promise<MissionControlServices | undefined> {
    if (workspaceRoot === undefined) return undefined;
    try {
        return await getOrCreateMissionControlServices(workspaceRoot);
    } catch (error: unknown) {
        if (isOmoRootNotFoundError(error)) {
            return undefined;
        }
        throw error;
    }
}
