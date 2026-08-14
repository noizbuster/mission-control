// allow: SIZE_OK -- HEAD 1339 -> current 1351 pure LOC; one interactive chat event-loop state machine after action extraction.
import {
    type AgentRuntime,
    type AskUserQuestionRequest,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type ContextCacheUsage,
    discoverSkills,
    discoverWorkflows,
    type BackgroundJobHandle,
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
    TuiSkillMenuEntry,
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
import { formatSessionFinalizeLineFromInfo, type SessionFinalizeInfo } from '../ui/session-finalize';
import { toggleDisabled } from './agents-disabled-config';
import { parseModelPatternString, setOverride } from './agents-model-overrides-config';
import { chatActionShowsWorkingStatus, parseChatLine } from './chat-commands';
import { appendInputHistoryEntry, getSharedHistoryStore, loadInputHistoryEntries } from './input-history-store';
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
    interruptActiveTurnBounded,
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
import { isApprovalDecisionLine } from './interactive-approval-helpers';
import { interactiveSessionCliStdout } from './interactive-session-cli-stdout';
import { emitTranscriptFallback } from './interactive-transcript-emission';
import {
    getOrCreateMissionControlServices,
    isMcRootNotFoundError,
    type MissionControlServices,
} from './mission-control-services';
import { loadEffectiveContextLimit, maybeStartAutoCompaction } from './model-context-session';
import { loadPricingTable } from './pricing-table-store';
import type { EnsuredSession } from './run-agent-session';
import { applySessionAttachProjection, projectSessionAttachFromEvents } from './session-attach-projection';
import { listSessionCatalogEntriesForWorkspace } from './session-catalog';
import {
    loadSessionTranscriptParts,
    loadSessionTranscriptPartsAndEventsFromStore,
} from './session-transcript-reconstruction';
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

export function toTuiSkillMenuEntries(skills: readonly Skill[]): readonly TuiSkillMenuEntry[] {
    return skills.map((skill) => {
        const description = skill.description.trim();
        return {
            name: skill.name,
            description: description.length > 0 ? description : `Load the ${skill.name} skill`,
        };
    });
}

/**
 * A usage/cache callback belongs to the session that created its turn, not the
 * session currently selected after an async navigation completes.
 */
export function isSessionUsageProjectionLive(input: {
    readonly expectedSessionId: string | undefined;
    readonly currentSessionId: string | undefined;
    readonly tuiSessionId: string | undefined;
    readonly eventQueueClosed: boolean;
}): boolean {
    if (input.eventQueueClosed || input.currentSessionId !== input.expectedSessionId) return false;
    return input.tuiSessionId === undefined || input.tuiSessionId === (input.expectedSessionId ?? '');
}

/** A live provider callback additionally belongs to the currently admitted turn. */
export function isLiveTurnUsageProjection(input: {
    readonly expectedSessionId: string | undefined;
    readonly currentSessionId: string | undefined;
    readonly tuiSessionId: string | undefined;
    readonly eventQueueClosed: boolean;
    readonly expectedTurnEpoch: number;
    readonly currentTurnEpoch: number;
}): boolean {
    return input.expectedTurnEpoch === input.currentTurnEpoch && isSessionUsageProjectionLive(input);
}

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
    readonly sessionFinalizeSink?: MutableSessionFinalizeSink;
};

export type PlainPromptGraph = 'default-workflow' | 'coding-agent';

export type MutableSessionFinalizeSink = { info?: SessionFinalizeInfo };

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
        // omp task-toast pattern: surface background job settlement while the
        // operator is in chat. TUI-only — plain/JSON paths pin exact output and
        // job results remain retrievable through session-resume salvage.
        (handle) => {
            if (tuiHandle === undefined || tuiHandle.isEventQueueClosed()) return;
            const label = handle.agentId ?? handle.jobId;
            const detail =
                handle.status === 'failed' && handle.error !== undefined
                    ? ` — ${options.observabilityRedactor?.redactText(handle.error) ?? handle.error}`
                    : '';
            tuiHandle.showTransientNotice(`Background job ${label} ${handle.status}${detail}`);
        },
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
              promptHistoryStore: getSharedHistoryStore(),
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
    // Mirror of the conversation text for /undo and /redo. This is display-only;
    // the durable session store is never modified by undo/redo.
    // Declared before TUI mount so subscribeOutput can close over it safely.
    let conversationText = '';
    let tuiHandle: ChatTuiHandle | undefined;
    if (useTui && tuiRuntimeOptions !== undefined) {
        const { createChatTui } = await import('@mission-control/tui/create-chat-tui');
        tuiHandle = await createChatTui(tuiRuntimeOptions);
    }
    // Keep the non-TUI conversationText mirror aligned when App recovery
    // replaceTranscript (or any store output rewrite) changes live output.
    const unsubscribeTuiOutput =
        tuiHandle === undefined
            ? undefined
            : tuiHandle.subscribeOutput((output) => {
                  conversationText = output;
              });
    const chatInput: ChatInput =
        options.input ??
        (tuiHandle !== undefined
            ? {
                  read: () => tuiHandle.waitForEvent(),
                  close: () => {
                      unsubscribeTuiOutput?.();
                      tuiHandle.unmount();
                  },
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
                  writeTranscriptPart: (part, fallbackText) => tuiHandle.emitTranscriptPart(part, fallbackText),
                  writeTranscriptFallback: (text) => tuiHandle.emitTranscriptFallback(text),
                  getOutput: () => tuiHandle.getOutput(),
                  setAgentStatus: (text) => tuiHandle.setAgentStatus(text),
                  setAgentRetryStatus: (text, retryAt) => tuiHandle.setAgentRetryStatus(text, retryAt),
                  clearAgentStatus: () => tuiHandle.clearAgentStatus(),
                  showNotice: (text) => tuiHandle.showTransientNotice(text),
                  setStickyNotice: (message) => tuiHandle.setStickyNotice(message),
                  isShowThinking: () => tuiHandle.isShowThinking(),
                  isToolOutputExpanded: () => tuiHandle.isToolOutputExpanded(),
                  showApproval: (toolName, action) => tuiHandle.showApproval(toolName, action),
                  hideApproval: () => tuiHandle.hideApproval(),
              }
            : createTerminalChatOutput());
    let undoRedoStack = createUndoRedoStack();
    const baseWriteTranscriptPart = baseChatOutput.writeTranscriptPart;
    const baseWriteTranscriptFallback = baseChatOutput.writeTranscriptFallback;
    const chatOutput: ChatOutput = {
        ...baseChatOutput,
        write: (text: string) => {
            conversationText += text;
            baseChatOutput.write(text);
        },
        ...(baseWriteTranscriptPart !== undefined
            ? {
                  writeTranscriptPart: (part, fallbackText) => {
                      conversationText += fallbackText;
                      baseWriteTranscriptPart(part, fallbackText);
                  },
              }
            : {}),
        ...(baseWriteTranscriptFallback !== undefined
            ? {
                  writeTranscriptFallback: (text: string) => {
                      conversationText += text;
                      baseWriteTranscriptFallback(text);
                  },
              }
            : {}),
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
        undoLastViewExchange: () => {
            if (tuiHandle === undefined) return 'empty' as const;
            const result = tuiHandle.undoLastViewExchange();
            conversationText = tuiHandle.getOutput();
            return result;
        },
        redoLastViewExchange: () => {
            if (tuiHandle === undefined) return 'empty' as const;
            const result = tuiHandle.redoLastViewExchange();
            conversationText = tuiHandle.getOutput();
            return result;
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
    let lastContextTokensUsed: number | undefined;
    let liveTurnUsageEpoch = 0;
    let sessionCacheUsage: ContextCacheUsage | undefined;
    const setSessionCacheUsage = (usage: ContextCacheUsage | undefined): void => {
        if (tuiHandle?.isEventQueueClosed() === true) return;
        sessionCacheUsage = usage;
        tuiHandle?.setContextCacheUsage(usage);
    };

    const isUsageSessionLive = (expectedSessionId: string | undefined): boolean =>
        isSessionUsageProjectionLive({
            expectedSessionId,
            currentSessionId,
            tuiSessionId: tuiHandle?.getSessionId(),
            eventQueueClosed: tuiHandle?.isEventQueueClosed() === true,
        });

    const addSessionCacheUsage = (usage: ContextCacheUsage): void => {
        const previous = sessionCacheUsage;
        if (previous === undefined) {
            setSessionCacheUsage(usage);
            return;
        }
        const inputTokens = previous.inputTokens + usage.inputTokens;
        const cacheReadTokens = previous.cacheReadTokens + usage.cacheReadTokens;
        setSessionCacheUsage(
            Number.isSafeInteger(inputTokens) && Number.isSafeInteger(cacheReadTokens)
                ? { inputTokens, cacheReadTokens }
                : undefined,
        );
    };

    let lastCodingContext: CodingActionContext | undefined;
    let turnCounter = 0;
    const inputPump = new ChatInputPump(chatInput);
    let currentSessionId = options.sessionId;
    tuiHandle?.setSessionId(currentSessionId ?? '');
    {
        const sessionAtBootLimit = currentSessionId;
        const selectionAtBootLimit = currentModelProviderSelection;
        const contextMaxEpochAtBoot = tuiHandle?.beginContextMaxReseed() ?? 0;
        void loadEffectiveContextLimit(selectionAtBootLimit)
            .then((limit) => {
                if (tuiHandle === undefined || tuiHandle.isEventQueueClosed()) return;
                if (!tuiHandle.shouldApplyContextMaxReseed(contextMaxEpochAtBoot)) return;
                if (currentSessionId !== sessionAtBootLimit) return;
                if (
                    currentModelProviderSelection.providerID !== selectionAtBootLimit.providerID ||
                    currentModelProviderSelection.modelID !== selectionAtBootLimit.modelID
                ) {
                    return;
                }
                tuiHandle.setContextTokensMax(limit);
            })
            .catch(() => undefined);
    }
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
    let titleGenerationAbortController = new AbortController();
    const titleGenerationTasks = new Set<Promise<void>>();
    const invalidateTitleGeneration = (): void => {
        manualRenameRevision += 1;
        titleGenerationAbortController.abort();
        titleGenerationAbortController = new AbortController();
    };
    const reseedContextMaxForSelection = (
        sessionAtLimit: string | undefined,
        selectionAtLimit: ModelProviderSelection,
    ): void => {
        const contextMaxEpoch = tuiHandle?.beginContextMaxReseed() ?? 0;
        void loadEffectiveContextLimit(selectionAtLimit)
            .then((limit) => {
                if (tuiHandle === undefined || tuiHandle.isEventQueueClosed()) return;
                if (!tuiHandle.shouldApplyContextMaxReseed(contextMaxEpoch)) return;
                if (currentSessionId !== sessionAtLimit) return;
                if (
                    currentModelProviderSelection.providerID !== selectionAtLimit.providerID ||
                    currentModelProviderSelection.modelID !== selectionAtLimit.modelID
                ) {
                    return;
                }
                tuiHandle.setContextTokensMax(limit);
            })
            .catch(() => undefined);
    };

    /**
     * Commit a navigated/ensured session id. Wipes CLI usage mirrors and display-name
     * controller immediately so auto-title and auto-compact cannot see the prior session.
     * When a TUI is mounted, also syncs store session id (which wipes TUI context/display).
     */

    const commitSessionIdentity = (
        sessionId: string,
        sessionStore?: import('./interactive-chat-prompt-turn').PromptTurnContext['sessionStore'],
    ): void => {
        const cliChanged = sessionId !== currentSessionId;
        const tuiChanged = tuiHandle !== undefined && tuiHandle.getSessionId() !== sessionId;
        if (sessionStore !== undefined) {
            currentSessionStore = sessionStore;
        }
        if (!cliChanged && !tuiChanged) return;
        if (cliChanged) {
            invalidateTitleGeneration();
            currentSessionId = sessionId;
            lastContextTokensUsed = undefined;
            setSessionCacheUsage(undefined);
            // Clear CLI controller immediately — do not wait for catalog sync.
            sessionDisplayNameController.update('');
            setTerminalTitle(formatAppTitle(getVersion()));
        }
        if (tuiHandle !== undefined && tuiChanged) {
            tuiHandle.setSessionId(sessionId);
            // setSessionId already wiped TUI display/context; keep CLI mirrors aligned.
            lastContextTokensUsed = undefined;
            setSessionCacheUsage(undefined);
        }
        if (cliChanged || tuiChanged) {
            reseedContextMaxForSelection(sessionId, currentModelProviderSelection);
        }
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
                      await drainSessionTitleWriteQueue(enqueueSessionTitleWrite);
                      const store = await switchSessionStore(sessionId);
                      // Shared wipe/reseed for TUI and non-TUI (usage mirrors + display controller).
                      commitSessionIdentity(sessionId, store);
                      return store;
                  },
                  ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
                  ...(options.observeStoredEvent !== undefined
                      ? { observeStoredEvent: options.observeStoredEvent }
                      : {}),
              });

    let sessionFinalizeInfo: SessionFinalizeInfo = { status: 'aborted' };
    let sessionFinalizeWritten = false;
    const writeSessionFinalize = (): void => {
        if (sessionFinalizeWritten) return;
        sessionFinalizeWritten = true;
        const line = formatSessionFinalizeLineFromInfo(sessionFinalizeInfo);
        try {
            chatOutput.write(`${line}\n`);
        } catch {
            // chatOutput may be torn down during cleanup; suppress.
        }
        if (tuiHandle !== undefined) {
            // TUI is unmounted by chatInput.close() below, so chatOutput no longer reaches the
            // terminal. Mirror to stderr so the user still sees the finalize line.
            try {
                process.stderr.write(`${line}\n`);
            } catch {
                // stderr write failure is not recoverable; suppress.
            }
        }
    };

    const unregisterProcessCleanup =
        tuiHandle === undefined
            ? registerProcessTerminalCleanup(chatInput, {
                  onForceExit: () => {
                      if (!sessionFinalizeWritten) {
                          sessionFinalizeInfo = { status: 'aborted', reason: 'interrupted by signal' };
                      }
                      writeSessionFinalize();
                  },
              })
            : undefined;

    const syncSessionDisplayName = async (sessionId: string | undefined): Promise<void> => {
        const sid = sessionId ?? '';
        const renameRevisionAtSync = manualRenameRevision;
        if (sid.length === 0) {
            if (currentSessionId !== undefined && currentSessionId.length > 0) return;
            if (tuiHandle?.isEventQueueClosed() === true) return;
            if (manualRenameRevision !== renameRevisionAtSync) return;
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
        // Drop stale catalog results after a session switch, rename, or teardown.
        if (currentSessionId !== sid) return;
        if (manualRenameRevision !== renameRevisionAtSync) return;
        if (tuiHandle?.isEventQueueClosed() === true) return;
        sessionDisplayNameController.update(name ?? '');
        tuiHandle?.setSessionDisplayName(name);
        setTerminalTitle(formatSessionTitle(sid, name));
    };

    const applySessionRenameEffects = async (name: string): Promise<void> => {
        const targetSessionId = currentSessionId;
        const targetModelProviderSelection = currentModelProviderSelection;
        const previousName = sessionDisplayNameController.current() ?? '';
        const previousTitleName = previousName.length > 0 ? previousName : undefined;
        const renameRevisionAtStart = manualRenameRevision;
        if (targetSessionId !== undefined && currentSessionId === targetSessionId) {
            if (tuiHandle?.isEventQueueClosed() !== true) {
                sessionDisplayNameController.update(name);
                tuiHandle?.setSessionDisplayName(name);
                setTerminalTitle(formatSessionTitle(targetSessionId, name));
            }
        }
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
                // Roll back optimistic title only if no newer rename/invalidation landed.
                if (
                    currentSessionId === targetSessionId &&
                    manualRenameRevision === renameRevisionAtStart &&
                    tuiHandle?.isEventQueueClosed() !== true
                ) {
                    sessionDisplayNameController.update(previousName);
                    tuiHandle?.setSessionDisplayName(previousTitleName);
                    setTerminalTitle(formatSessionTitle(targetSessionId, previousTitleName));
                }
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
            const sessionAtContextLimit = currentSessionId;
            const selectionAtContextLimit = selection;
            const contextMaxEpochAtCycle = tuiHandle.beginContextMaxReseed();
            void loadEffectiveContextLimit(selection)
                .then((limit) => {
                    if (tuiHandle.isEventQueueClosed() || currentSessionId !== sessionAtContextLimit) return;
                    if (!tuiHandle.shouldApplyContextMaxReseed(contextMaxEpochAtCycle)) return;
                    if (
                        currentModelProviderSelection.providerID !== selectionAtContextLimit.providerID ||
                        currentModelProviderSelection.modelID !== selectionAtContextLimit.modelID
                    ) {
                        return;
                    }
                    tuiHandle.setContextTokensMax(limit);
                })
                .catch(() => undefined);
        };
        tuiHandle.onRenameSubmit = (name: string) => {
            // applySessionRenameEffects owns optimistic UI + durable-fail rollback.
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
    tuiHandle?.setSkillEntries(toTuiSkillMenuEntries(sessionSkills));

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

        // Restore from the attached store when available. It is the authoritative
        // event source for the transcript, ABG overlay, context usage, and the
        // following model turn.
        if (currentSessionId !== undefined) {
            const bootSessionId = currentSessionId;
            const bootSessionStore = currentSessionStore;
            const attached =
                bootSessionStore === undefined
                    ? undefined
                    : await loadSessionTranscriptPartsAndEventsFromStore(
                          bootSessionStore,
                          bootSessionId,
                          options.observabilityRedactor,
                      );
            const resumed =
                attached ?? (await loadSessionTranscriptParts(bootSessionId, options.observabilityRedactor));
            // Load I/O can outlive teardown; never apply a stale boot attach.
            const bootAttachStale =
                currentSessionId !== bootSessionId ||
                currentSessionStore !== bootSessionStore ||
                tuiHandle?.isEventQueueClosed() === true;
            if (!bootAttachStale) {
                if (tuiHandle !== undefined) {
                    if (resumed.parts.length > 0 || resumed.outputText.length > 0) {
                        conversationText = resumed.outputText;
                        tuiHandle.replaceTranscript(resumed.parts, resumed.outputText);
                    }
                } else if (resumed.outputText.length > 0) {
                    chatOutput.write(resumed.outputText);
                }
                const events = attached?.events ?? [];
                applySessionAttachProjection({
                    events,
                    projection: projectSessionAttachFromEvents(events),
                    abgOverlayController,
                    chatOutput,
                    onUsage: (inputTokens) => {
                        if (!isUsageSessionLive(bootSessionId)) return;
                        lastContextTokensUsed = inputTokens;
                        tuiHandle?.setContextTokensUsed(inputTokens);
                    },
                    onContextCacheUsage: (usage) => {
                        if (!isUsageSessionLive(bootSessionId)) return;
                        setSessionCacheUsage(usage);
                    },
                });
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
                if (next.outcome === 'completed') {
                    const sessionAtAutoCompact = currentSessionId;
                    const storeAtAutoCompact = currentSessionStore;
                    const selectionAtAutoCompact = currentModelProviderSelection;
                    const autoCompactTurn = await maybeStartAutoCompaction({
                        usedTokens: lastContextTokensUsed,
                        selection: selectionAtAutoCompact,
                        sessionId: sessionAtAutoCompact,
                        sessionStore: storeAtAutoCompact,
                        provider: currentProvider,
                        output: chatOutput,
                        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
                        ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
                        ...(options.observeStoredEvent !== undefined
                            ? { observeStoredEvent: options.observeStoredEvent }
                            : {}),
                    });
                    if (autoCompactTurn !== undefined) {
                        const staleAutoCompact =
                            currentSessionId !== sessionAtAutoCompact ||
                            currentSessionStore !== storeAtAutoCompact ||
                            currentModelProviderSelection.providerID !== selectionAtAutoCompact.providerID ||
                            currentModelProviderSelection.modelID !== selectionAtAutoCompact.modelID ||
                            tuiHandle?.isEventQueueClosed() === true;
                        if (staleAutoCompact) {
                            autoCompactTurn.interrupt('soft');
                        } else {
                            workflowChainDepth = 0;
                            pendingWorkflowTurns.length = 0;
                            activeTurn = autoCompactTurn;
                            continue;
                        }
                    }
                }
                if (tuiHandle !== undefined) {
                    tuiHandle.setGenerating(false);
                    tuiHandle.clearAgentStatus();
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
                    await interruptActiveTurnBounded(interruptedTurn);
                    liveTurnUsageEpoch += 1;
                    activeTurn = undefined;
                    if (tuiHandle !== undefined) {
                        tuiHandle.setGenerating(false);
                        tuiHandle.clearAgentStatus();
                    }
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
                    sessionFinalizeInfo = { status: 'aborted', reason: 'interrupted by user' };
                    break;
                }
                pendingInterrupt = true;
                showExitHint('Press Ctrl+C again to exit');
                continue;
            }

            pendingInterrupt = false;
            const prompt = event.value.trim();
            // Single approval gate: answerApproval is a no-op when nothing is pending.
            if (activeTurn?.answerApproval(prompt) === true) {
                continue;
            }
            // Drop stale approval-vocab lines (late once/deny after settle/cancel)
            // so they never become normal user prompts.
            if (isApprovalDecisionLine(prompt)) {
                continue;
            }
            if (prompt.length === 0) {
                continue;
            }
            if (prompt.length > maxChatPromptLength) {
                chatOutput.write(`Prompt is too long (max ${maxChatPromptLength} characters).\n`);
                continue;
            }
            await appendInputHistoryEntry(prompt);

            const action = parseChatLine(event.value, {
                modelChoices,
                knownWorkflowNames,
                ...(currentSessionId !== undefined ? { currentSessionId } : {}),
            });
            if (action.kind === 'exit') {
                liveTurnUsageEpoch += 1;
                activeTurn = await stopActiveTurn(activeTurn);
                chatOutput.write('Exiting mission-control chat\n');
                sessionFinalizeInfo = { status: 'complete' };
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
                commitSessionIdentity(ensured.sessionId, ensured.store);
                const titleNavigation = sessionNavigation;
                if (action.kind === 'prompt' && titleNavigation !== undefined) {
                    const titleSessionId = ensured.sessionId;
                    await initializeInteractiveSessionTitle({
                        sessionId: titleSessionId,
                        prompt: action.prompt,
                        state: {
                            snapshot: () => ({
                                sessionId: currentSessionId,
                                displayName: sessionDisplayNameController.current(),
                                manualRenameRevision,
                            }),
                            displayTitle: (title) => {
                                if (currentSessionId !== titleSessionId) return;
                                if (tuiHandle?.isEventQueueClosed() === true) return;
                                sessionDisplayNameController.update(title);
                                tuiHandle?.setSessionDisplayName(title);
                                setTerminalTitle(formatSessionTitle(titleSessionId, title));
                            },
                            persistTitle: async (title) => {
                                if (currentSessionId !== titleSessionId) return;
                                if (tuiHandle?.isEventQueueClosed() === true) return;
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
            if (tuiHandle !== undefined && chatActionShowsWorkingStatus(action.kind)) {
                tuiHandle.setGenerating(true);
            }
            try {
                const usageTurnEpoch = ++liveTurnUsageEpoch;
                let usageSessionId = currentSessionId;
                const codingContext: CodingActionContext = {
                    activeTurn,
                    useTui,
                    isUiClosed: () => tuiHandle?.isEventQueueClosed() === true,
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
                        tuiHandle?.setSkillEntries(toTuiSkillMenuEntries(skills));
                    },
                    workflowRegistry: sessionWorkflowRegistry,
                    onWorkflowStarted,
                    ...(options.plainPromptGraph !== undefined ? { plainPromptGraph: options.plainPromptGraph } : {}),
                    sessionDisplayName: sessionDisplayNameController,
                    onSessionRenamed: applyManualSessionRename,
                    undoRedo: undoRedoController,
                    commitAttachedSession: (sessionId, sessionStore) => {
                        commitSessionIdentity(sessionId, sessionStore);
                        usageSessionId = sessionId;
                    },
                    onUsage: (inputTokens: number | undefined) => {
                        if (
                            !isLiveTurnUsageProjection({
                                expectedSessionId: usageSessionId,
                                currentSessionId,
                                tuiSessionId: tuiHandle?.getSessionId(),
                                eventQueueClosed: tuiHandle?.isEventQueueClosed() === true,
                                expectedTurnEpoch: usageTurnEpoch,
                                currentTurnEpoch: liveTurnUsageEpoch,
                            })
                        ) {
                            return;
                        }
                        lastContextTokensUsed = inputTokens;
                        tuiHandle?.setContextTokensUsed(inputTokens);
                    },
                    // Absolute cache snapshot (attach projection).
                    onSessionCacheUsage: (usage) => {
                        if (!isUsageSessionLive(usageSessionId)) return;
                        setSessionCacheUsage(usage);
                    },
                    onContextCacheUsage: (usage) => {
                        if (
                            !isLiveTurnUsageProjection({
                                expectedSessionId: usageSessionId,
                                currentSessionId,
                                tuiSessionId: tuiHandle?.getSessionId(),
                                eventQueueClosed: tuiHandle?.isEventQueueClosed() === true,
                                expectedTurnEpoch: usageTurnEpoch,
                                currentTurnEpoch: liveTurnUsageEpoch,
                            })
                        ) {
                            return;
                        }
                        addSessionCacheUsage(usage);
                    },
                    ...(sessionNavigation !== undefined ? { sessionNavigation } : {}),
                    ...(tuiHandle !== undefined
                        ? {
                              replaceSessionTranscript: (parts, outputText) => {
                                  conversationText = outputText;
                                  tuiHandle.replaceTranscript(parts, outputText);
                              },
                          }
                        : {}),
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
                emitTranscriptFallback(chatOutput, `Error: ${message}\n`);
                if (tuiHandle !== undefined) {
                    tuiHandle.setGenerating(false);
                    tuiHandle.clearAgentStatus();
                }
                continue;
            }
            if (tuiHandle !== undefined) {
                // Keep generating while an active turn (incl. approval wait) lives
                // so Ctrl+C routes to interrupt instead of draft-clear.
                tuiHandle.setGenerating(result.activeTurn !== undefined);
                if (result.activeTurn === undefined) {
                    tuiHandle.clearAgentStatus();
                }
            }
            if (!areModelProviderSelectionsEqual(currentModelProviderSelection, result.modelProviderSelection)) {
                currentProvider =
                    options.resolveProviderForSelection?.(result.modelProviderSelection) ?? currentProvider;
                if (result.persistModelProviderSelection === true) {
                    await options.persistModelProviderSelection?.(result.modelProviderSelection);
                }
                // Sync store so Ctrl+V variant cycling targets the new base.
                tuiHandle?.setModelSelection(result.modelProviderSelection);
                const sessionAtTurnLimit = currentSessionId;
                const selectionAtTurnLimit = result.modelProviderSelection;
                const contextMaxEpochAtTurn = tuiHandle?.beginContextMaxReseed() ?? 0;
                void loadEffectiveContextLimit(result.modelProviderSelection)
                    .then((limit) => {
                        if (tuiHandle === undefined || tuiHandle.isEventQueueClosed()) return;
                        if (!tuiHandle.shouldApplyContextMaxReseed(contextMaxEpochAtTurn)) return;
                        if (currentSessionId !== sessionAtTurnLimit) return;
                        if (
                            currentModelProviderSelection.providerID !== selectionAtTurnLimit.providerID ||
                            currentModelProviderSelection.modelID !== selectionAtTurnLimit.modelID
                        ) {
                            return;
                        }
                        tuiHandle.setContextTokensMax(limit);
                    })
                    .catch(() => undefined);
            }
            currentModelProviderSelection = result.modelProviderSelection;
            activeTurn = result.activeTurn;
            if (result.sessionId !== undefined && result.sessionId !== currentSessionId) {
                invalidateTitleGeneration();
                await drainSessionTitleWriteQueue(enqueueSessionTitleWrite);
            }
            // Shared wipe/reseed when the action advanced the session id.
            // Same-id (including after commitAttachedSession) is a no-op.
            if (result.sessionId !== undefined) {
                commitSessionIdentity(result.sessionId, result.sessionStore);
            }
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
    } catch (error: unknown) {
        if (!sessionFinalizeWritten) {
            sessionFinalizeInfo = {
                status: 'failed',
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        throw error;
    } finally {
        writeSessionFinalize();
        if (options.sessionFinalizeSink !== undefined) {
            options.sessionFinalizeSink.info = sessionFinalizeInfo;
        }
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
    onTerminalJob?: (handle: BackgroundJobHandle) => void,
): Promise<MissionControlServices | undefined> {
    if (workspaceRoot === undefined) return undefined;
    try {
        return await getOrCreateMissionControlServices(workspaceRoot, {
            ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
            ...(onTerminalJob !== undefined ? { onTerminalJob } : {}),
        });
    } catch (error: unknown) {
        if (isMcRootNotFoundError(error)) {
            return undefined;
        }
        throw error;
    }
}
