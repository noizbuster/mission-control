// allow: SIZE_OK — indivisible reactive store; the ~48-field state shape and
// matching initial-state literal are pure data tables dictated by the bridge
// core contract, and every action mutates the same state object. Dashboard
// overlays nest as sub-state objects (agentsDashboard) to keep the top-level
// field count flat.
import { type ModelProviderSelection, type ModelRole } from '@mission-control/protocol';
import type { ProviderAuthStore } from '../auth-store.js';
import { PasteMarkerStore } from '../platform/keymap/bracketed-paste.js';
import type { DiffEntry } from '../platform/keymap/diff-viewer.js';
import { APPROVAL_LEVELS, type ApprovalLevel, isApprovalLevel } from './approval-level.js';
import {
    createProviderPromptKeypressState,
    filterProviderPromptChoices,
    type ProviderPromptKeypressState,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';
import {
    createSlashCommandMenuState,
    reduceSlashCommandMenuSelection,
    reduceWorkflowCommandMenuSelection,
    type SlashCommandMenuState,
} from './interactive-chat-command-menu.js';
import {
    createFileAutocompleteState,
    type FileAutocompleteState,
    navigateFileAutocompleteDown,
    navigateFileAutocompleteUp,
    updateFileAutocomplete,
} from './interactive-chat-file-autocomplete.js';
import {
    type ChatInputHistory,
    createChatInputHistory,
    createChatInputHistoryFromEntries,
    isNavigatingChatInputHistory,
    navigateChatInputHistoryDown,
    navigateChatInputHistoryUp,
    recordSubmittedPrompt,
} from './interactive-chat-input-history.js';
import type { ChatInputEvent } from './interactive-chat-io.js';
import { createVariantChoices, type ModelChoice } from './interactive-chat-model.js';
import {
    type ModelsOverlayRoleRow,
    type ModelsOverlayState,
    navigateModelsOverlayDown,
    navigateModelsOverlayUp,
    switchModelsOverlayColumn as reduceModelsOverlayColumn,
    setModelsOverlayProviderTab as reduceModelsOverlayProviderTab,
    setModelsOverlaySearchQuery as reduceModelsOverlaySearchQuery,
} from './models-overlay-state.js';
import { normalizeQuestionOptions, type QuestionOption } from './question-types.js';

export type ChatStoreOverlayMode =
    | 'none'
    | 'model-picker'
    | 'level-picker'
    | 'approval'
    | 'question'
    | 'rename'
    | 'abg'
    | 'diff-viewer'
    | 'session-picker'
    | 'agents-dashboard'
    | 'models-overlay';

export type AgentsDashboardSourceTab = 'all' | 'project' | 'user' | 'bundled';

export type DashboardAgentEntry = {
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly model?: string;
    readonly tier?: string;
    readonly disabled: boolean;
    readonly overrideModel?: string;
    readonly filePath?: string;
};

export type AgentsDashboardState = {
    readonly active: boolean;
    readonly agents: readonly DashboardAgentEntry[];
    readonly selectedIndex: number;
    readonly sourceTab: AgentsDashboardSourceTab;
    readonly editingName: string | null;
    readonly editBuffer: string;
};

/** Slice backing the models overlay. `roleRows` (right column) is built from
 *  persisted assignments + fallback by the action handler on open. The left
 *  column is narrowed by `searchQuery` (substring) and `activeProviderTab`
 *  (`'all'` or a providerID). */
export type ModelsOverlaySlice = {
    readonly active: boolean;
    readonly entries: readonly ModelProviderSelection[];
    readonly roleRows: readonly ModelsOverlayRoleRow[];
    readonly activeLeftIndex: number;
    readonly activeRightIndex: number;
    readonly focusedColumn: 'left' | 'right';
    readonly searchQuery: string;
    readonly activeProviderTab: string;
};

export type AgentsDashboardSourceTabInfo = {
    readonly id: AgentsDashboardSourceTab;
    readonly label: string;
    readonly count: number;
};

export type AgentsDashboardView = {
    readonly sourceTabs: readonly AgentsDashboardSourceTabInfo[];
    readonly visibleEntries: readonly DashboardAgentEntry[];
    readonly selectedIndex: number;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly totalCount: number;
    readonly inspectorEntry: DashboardAgentEntry | null;
};

export type SessionPickerEntry = {
    readonly sessionId: string;
    readonly label: string;
    readonly updatedAt?: string;
    readonly messageCount: number;
    readonly status: string;
};

export type SessionPickerView = {
    readonly filteredEntries: readonly SessionPickerEntry[];
    readonly visibleEntries: readonly SessionPickerEntry[];
    readonly selectedIndex: number;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly totalCount: number;
    readonly searchQuery: string;
};

export type ChatStoreState = {
    readonly outputText: string;
    readonly sessionId: string;
    /** Live session display name; rename overlay falls back to `sessionId` when this is empty. */
    readonly sessionDisplayName: string;
    readonly inputMirror: string;
    readonly generating: boolean;
    readonly agentStatusText: string;
    readonly showThinking: boolean;
    readonly toolOutputExpanded: boolean;
    readonly approvalLevel: ApprovalLevel | undefined;
    readonly workflowNames: readonly string[];
    readonly modelCycleChoices: readonly ModelChoice[];
    readonly modelCycleIndex: number;
    /** Single source of truth for the live selection; `setModelSelection` keeps `modelCycleIndex` aligned when the base matches a cycle entry. */
    readonly currentModelSelection: ModelProviderSelection | undefined;
    /** Mirror of `currentModelSelection.variantID`; used by `cycleModelVariant` to find its rotation slot. */
    readonly currentModelVariantID: string | undefined;
    readonly menuState: SlashCommandMenuState;
    readonly fileAutocomplete: FileAutocompleteState;
    readonly history: ChatInputHistory;
    readonly pasteStore: PasteMarkerStore;
    readonly pasteCounter: number;
    readonly overlayMode: ChatStoreOverlayMode;
    readonly approvalToolName: string;
    readonly approvalAction: string;
    readonly approvalSelectedIndex: number;
    readonly questionText: string;
    readonly questionHeader: string;
    readonly questionOptions: readonly QuestionOption[];
    readonly questionSelectedIndex: number;
    readonly questionMultiple: boolean;
    readonly questionSelectedIndices: Set<number>;
    readonly questionCustomMode: boolean;
    readonly questionCustomBuffer: string;
    readonly modelPickerChoices: readonly ModelChoice[];
    readonly modelPickerKeypress: ProviderPromptKeypressState;
    readonly levelPickerSelectedIndex: number;
    readonly renameBuffer: string;
    readonly abgOverlayActiveTab: number;
    readonly abgOverlayScrollOffset: number;
    readonly abgOverlayLiveOutput: boolean;
    readonly diffViewerEntries: readonly DiffEntry[];
    readonly diffViewerCursor: number;
    readonly sessionPickerEntries: readonly SessionPickerEntry[];
    readonly sessionPickerSelectedIndex: number;
    readonly sessionPickerSearch: string;
    readonly sessionPickerKeypress: ProviderPromptKeypressState;
    readonly agentsDashboard: AgentsDashboardState;
    readonly modelsOverlay: ModelsOverlaySlice;
    readonly contextTokensUsed: number | undefined;
    readonly contextTokensMax: number | undefined;
    readonly historyNavigation: { readonly position: number; readonly total: number } | null;
    readonly transientNotice: { readonly id: number; readonly message: string } | null;
};

type ChatStoreMutableState = {
    -readonly [K in keyof Omit<ChatStoreState, 'historyNavigation'>]: Omit<ChatStoreState, 'historyNavigation'>[K];
};

export type ChatStoreOptions = {
    readonly workspaceRoot?: string;
    readonly initialHistoryEntries?: readonly string[];
    readonly initialApprovalLevel?: ApprovalLevel;
    readonly authStore?: ProviderAuthStore;
};

export type AbgOverlayPrefsSnapshot = {
    readonly activeTabIndex: number;
    readonly scrollOffset: number;
    readonly liveOutput: boolean;
    readonly showThinking: boolean;
    readonly toolOutputExpanded: boolean;
};

const WHITESPACE_PATTERN = /\s/u;
const EMIT_COALESCE_MS = 16;
const CURSOR_UP = '\u001b[A';
const CURSOR_DOWN = '\u001b[B';
const APPROVAL_LEVEL_DEFAULT_INDEX = 1;

export const APPROVAL_OPTIONS = [
    { key: 'once', label: 'Allow once', description: 'allow this request only' },
    { key: 'session', label: 'Allow session', description: 'allow for this session only' },
    { key: 'always', label: 'Always allow', description: 'allow all future matching requests (persisted)' },
    { key: 'deny', label: 'Deny', description: 'block this request' },
] as const;

export const APPROVAL_LEVEL_PICKER_ENTRIES: readonly {
    readonly id: string;
    readonly label: string;
    readonly desc: string;
}[] = [
    { id: 'verbose', label: 'verbose', desc: 'Ask for every tool call, including reads' },
    { id: 'safe', label: 'safe', desc: 'Auto-approve reads and webfetch; ask before modifications' },
    { id: 'aggressive', label: 'aggressive', desc: 'Auto-approve reads, edits, webfetch, subagent; ask before bash' },
    { id: 'reckless', label: 'reckless', desc: 'Auto-approve everything; only bash asks before execution' },
    { id: 'yolo', label: 'yolo', desc: 'Auto-approve everything including subagent (use with caution)' },
];

function readActiveFilePrefix(buffer: string): string | undefined {
    if (buffer.startsWith('/') || buffer.startsWith('#')) {
        return undefined;
    }
    const atIndex = buffer.lastIndexOf('@');
    if (atIndex === -1) {
        return undefined;
    }
    const prefix = buffer.slice(atIndex + 1);
    if (WHITESPACE_PATTERN.test(prefix)) {
        return undefined;
    }
    return prefix;
}

export class ChatStore {
    onModelCycleSelect: ((selection: ModelProviderSelection) => void) | undefined;
    onRenameSubmit: ((name: string) => void) | undefined;

    private readonly workspaceRoot: string;
    private readonly authStore: ProviderAuthStore | undefined;
    private readonly listeners = new Set<() => void>();
    private readonly eventQueue: ChatInputEvent[] = [];
    private readonly eventWaiters: Array<(event: ChatInputEvent) => void> = [];
    private readonly state: ChatStoreMutableState;
    private snapshot: ChatStoreState;
    private modelPickerResolve: ((selection: ModelProviderSelection | undefined) => void) | undefined;
    private levelPickerResolve: ((level: string | undefined) => void) | undefined;
    private questionResolve: ((answer: string) => void) | undefined;
    private sessionPickerResolve: ((sessionId: string | undefined) => void) | undefined;
    private emitScheduled = false;
    private transientNoticeCounter = 0;

    constructor(options?: ChatStoreOptions) {
        this.workspaceRoot = options?.workspaceRoot ?? process.cwd();
        this.authStore = options?.authStore;
        const history =
            options?.initialHistoryEntries !== undefined
                ? createChatInputHistoryFromEntries(options.initialHistoryEntries)
                : createChatInputHistory();
        this.state = {
            outputText: '',
            sessionId: '',
            sessionDisplayName: '',
            inputMirror: '',
            generating: false,
            agentStatusText: '',
            showThinking: true,
            toolOutputExpanded: false,
            approvalLevel: options?.initialApprovalLevel,
            workflowNames: [],
            modelCycleChoices: [],
            modelCycleIndex: 0,
            currentModelSelection: undefined,
            currentModelVariantID: undefined,
            menuState: createSlashCommandMenuState(),
            fileAutocomplete: createFileAutocompleteState(),
            history,
            pasteStore: new PasteMarkerStore(),
            pasteCounter: 0,
            overlayMode: 'none',
            approvalToolName: '',
            approvalAction: '',
            approvalSelectedIndex: 0,
            questionText: '',
            questionHeader: '',
            questionOptions: [],
            questionSelectedIndex: 0,
            questionMultiple: false,
            questionSelectedIndices: new Set<number>(),
            questionCustomMode: false,
            questionCustomBuffer: '',
            modelPickerChoices: [],
            modelPickerKeypress: createProviderPromptKeypressState(),
            levelPickerSelectedIndex: 0,
            renameBuffer: '',
            abgOverlayActiveTab: 0,
            abgOverlayScrollOffset: 0,
            abgOverlayLiveOutput: false,
            diffViewerEntries: [],
            diffViewerCursor: 0,
            sessionPickerEntries: [],
            sessionPickerSelectedIndex: 0,
            sessionPickerSearch: '',
            sessionPickerKeypress: createProviderPromptKeypressState(),
            agentsDashboard: {
                active: false,
                agents: [],
                selectedIndex: 0,
                sourceTab: 'all',
                editingName: null,
                editBuffer: '',
            },
            modelsOverlay: {
                active: false,
                entries: [],
                roleRows: [],
                activeLeftIndex: 0,
                activeRightIndex: 0,
                focusedColumn: 'left',
                searchQuery: '',
                activeProviderTab: 'all',
            },
            contextTokensUsed: undefined,
            contextTokensMax: undefined,
            transientNotice: null,
        };
        this.snapshot = this.buildSnapshot();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    getSnapshot(): ChatStoreState {
        return this.snapshot;
    }

    emitOutput(text: string): void {
        this.state.outputText += text;
        if (!this.emitScheduled) {
            this.emitScheduled = true;
            setTimeout(() => {
                this.emitScheduled = false;
                this.publish();
            }, EMIT_COALESCE_MS);
        }
    }

    replaceOutputText(text: string): void {
        this.state.outputText = text;
        this.publish();
    }

    getOutput(): string {
        return this.state.outputText;
    }

    showModelPicker(choices: readonly ModelChoice[]): Promise<ModelProviderSelection | undefined> {
        if (choices.length === 0) {
            return Promise.resolve(undefined);
        }
        this.state.modelPickerChoices = choices;
        this.state.modelPickerKeypress = createProviderPromptKeypressState();
        this.state.overlayMode = 'model-picker';
        this.publish();
        return new Promise<ModelProviderSelection | undefined>((resolve) => {
            this.modelPickerResolve = resolve;
        });
    }

    hideModelPicker(selection?: ModelProviderSelection): void {
        const resolve = this.modelPickerResolve;
        this.modelPickerResolve = undefined;
        this.state.overlayMode = 'none';
        this.publish();
        resolve?.(selection);
    }

    showSessionPicker(entries: readonly SessionPickerEntry[]): Promise<string | undefined> {
        if (entries.length === 0) {
            return Promise.resolve(undefined);
        }
        this.state.sessionPickerEntries = entries;
        this.state.sessionPickerKeypress = createProviderPromptKeypressState();
        this.state.sessionPickerSelectedIndex = 0;
        this.state.sessionPickerSearch = '';
        this.state.overlayMode = 'session-picker';
        this.publish();
        return new Promise<string | undefined>((resolve) => {
            this.sessionPickerResolve = resolve;
        });
    }

    hideSessionPicker(sessionId?: string): void {
        const resolve = this.sessionPickerResolve;
        this.sessionPickerResolve = undefined;
        this.state.overlayMode = 'none';
        this.publish();
        resolve?.(sessionId);
    }

    showLevelPicker(currentLevel?: string): Promise<string | undefined> {
        const currentIdx =
            currentLevel !== undefined && isApprovalLevel(currentLevel) ? APPROVAL_LEVELS.indexOf(currentLevel) : -1;
        this.state.levelPickerSelectedIndex = currentIdx >= 0 ? currentIdx : APPROVAL_LEVEL_DEFAULT_INDEX;
        this.state.overlayMode = 'level-picker';
        this.publish();
        return new Promise<string | undefined>((resolve) => {
            this.levelPickerResolve = resolve;
        });
    }

    hideLevelPicker(level?: string): void {
        const resolve = this.levelPickerResolve;
        this.levelPickerResolve = undefined;
        this.state.overlayMode = 'none';
        this.publish();
        resolve?.(level);
    }

    showApproval(toolName: string, action: string): void {
        this.state.overlayMode = 'approval';
        this.state.approvalToolName = toolName;
        this.state.approvalAction = action;
        this.state.approvalSelectedIndex = 0;
        this.publish();
    }

    hideApproval(): void {
        this.state.overlayMode = 'none';
        this.publish();
    }

    showQuestion(
        question: string,
        options: readonly (string | QuestionOption)[],
        metadata?: { readonly header?: string; readonly multiple?: boolean },
    ): Promise<string> {
        this.state.overlayMode = 'question';
        this.state.questionText = question;
        this.state.questionHeader = metadata?.header ?? '';
        this.state.questionOptions = normalizeQuestionOptions(options);
        this.state.questionSelectedIndex = 0;
        this.state.questionMultiple = metadata?.multiple ?? false;
        this.state.questionSelectedIndices = new Set<number>();
        this.state.questionCustomMode = false;
        this.state.questionCustomBuffer = '';
        this.publish();
        return new Promise<string>((resolve) => {
            this.questionResolve = resolve;
        });
    }

    resolveQuestion(answer: string): void {
        const resolve = this.questionResolve;
        this.questionResolve = undefined;
        this.state.overlayMode = 'none';
        this.publish();
        resolve?.(answer);
    }

    showRename(): void {
        this.state.overlayMode = 'rename';
        this.state.renameBuffer =
            this.state.sessionDisplayName.length > 0 ? this.state.sessionDisplayName : this.state.sessionId;
        this.publish();
    }

    submitRename(name: string): void {
        this.state.overlayMode = 'none';
        this.state.renameBuffer = '';
        this.publish();
        this.onRenameSubmit?.(name);
    }

    setApprovalLevel(level: ApprovalLevel | undefined): void {
        this.state.approvalLevel = level;
        this.publish();
    }

    setSessionId(sessionId: string): void {
        if (this.state.sessionId === sessionId) return;
        this.state.sessionId = sessionId;
        this.publish();
    }

    setSessionDisplayName(name: string | undefined): void {
        const next = name ?? '';
        if (this.state.sessionDisplayName === next) return;
        this.state.sessionDisplayName = next;
        this.publish();
    }

    setContextTokensUsed(used: number | undefined): void {
        this.state.contextTokensUsed = used;
        this.publish();
    }

    setContextTokensMax(max: number | undefined): void {
        this.state.contextTokensMax = max;
        this.publish();
    }

    enqueueEvent(event: ChatInputEvent): void {
        const waiter = this.eventWaiters.shift();
        if (waiter !== undefined) {
            waiter(event);
            return;
        }
        this.eventQueue.push(event);
    }

    waitForEvent(): Promise<ChatInputEvent> {
        const queued = this.eventQueue.shift();
        if (queued !== undefined) {
            return Promise.resolve(queued);
        }
        return new Promise<ChatInputEvent>((resolve) => {
            this.eventWaiters.push(resolve);
        });
    }

    setInputMirror(text: string): void {
        this.state.inputMirror = text;
        this.state.menuState = createSlashCommandMenuState();
        this.refreshFileAutocomplete();
        this.publish();
    }

    navigateSlashMenu(direction: 'up' | 'down'): void {
        this.state.menuState = reduceSlashCommandMenuSelection(
            this.state.menuState,
            direction === 'up' ? CURSOR_UP : CURSOR_DOWN,
            this.state.inputMirror,
        );
        this.publish();
    }

    navigateWorkflowMenu(direction: 'up' | 'down'): void {
        this.state.menuState = reduceWorkflowCommandMenuSelection(
            this.state.menuState,
            direction === 'up' ? CURSOR_UP : CURSOR_DOWN,
            this.state.inputMirror,
            this.state.workflowNames,
        );
        this.publish();
    }

    navigateFileAutocomplete(direction: 'up' | 'down'): void {
        this.state.fileAutocomplete =
            direction === 'up'
                ? navigateFileAutocompleteUp(this.state.fileAutocomplete)
                : navigateFileAutocompleteDown(this.state.fileAutocomplete);
        this.publish();
    }

    closeMenus(): void {
        this.state.menuState = createSlashCommandMenuState();
        this.state.fileAutocomplete = createFileAutocompleteState();
        this.publish();
    }

    setGenerating(value: boolean): void {
        this.state.generating = value;
        this.publish();
    }

    setAgentStatus(text: string): void {
        this.state.agentStatusText = text;
        this.publish();
    }

    clearAgentStatus(): void {
        this.state.agentStatusText = '';
        this.publish();
    }

    setWorkflowNames(names: readonly string[]): void {
        this.state.workflowNames = names;
        this.publish();
    }

    setModelCycleChoices(choices: readonly ModelChoice[]): void {
        this.state.modelCycleChoices = choices;
        const liveBase = this.state.currentModelSelection;
        const matchingIndex =
            liveBase === undefined
                ? -1
                : choices.findIndex(
                      (choice) =>
                          choice.selection.providerID === liveBase.providerID &&
                          choice.selection.modelID === liveBase.modelID,
                  );
        if (matchingIndex >= 0) {
            this.state.modelCycleIndex = matchingIndex;
        } else if (this.state.modelCycleIndex >= choices.length) {
            this.state.modelCycleIndex = 0;
        }
        this.publish();
    }

    toggleShowThinking(): void {
        this.state.showThinking = !this.state.showThinking;
        this.publish();
    }

    toggleToolOutputExpanded(): void {
        this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
        this.publish();
    }

    toggleAbgOverlay(): void {
        this.state.overlayMode = this.state.overlayMode === 'abg' ? 'none' : 'abg';
        this.publish();
    }

    applyAbgOverlayPrefs(prefs: AbgOverlayPrefsSnapshot): void {
        this.state.abgOverlayActiveTab = prefs.activeTabIndex;
        this.state.abgOverlayScrollOffset = prefs.scrollOffset;
        this.state.abgOverlayLiveOutput = prefs.liveOutput;
        this.state.showThinking = prefs.showThinking;
        this.state.toolOutputExpanded = prefs.toolOutputExpanded;
        this.publish();
    }

    getAbgOverlayPrefsSnapshot(): AbgOverlayPrefsSnapshot {
        return {
            activeTabIndex: this.state.abgOverlayActiveTab,
            scrollOffset: this.state.abgOverlayScrollOffset,
            liveOutput: this.state.abgOverlayLiveOutput,
            showThinking: this.state.showThinking,
            toolOutputExpanded: this.state.toolOutputExpanded,
        };
    }

    /**
     * Single entry point for any path that picks a model (Ctrl+P cycle,
     * F2/leader+N shortcut, `/model` picker, `/model provider/model` chat
     * command, or the initial chat selection). Updates `currentModelSelection`,
     * mirrors `currentModelVariantID`, re-aligns `modelCycleIndex` when the
     * base matches a cycle entry, and forwards to `onModelCycleSelect` so the
     * imperative loop's provider config tracks the same selection.
     */
    setModelSelection(selection: ModelProviderSelection): void {
        this.state.currentModelSelection = selection;
        this.state.currentModelVariantID = selection.variantID;
        const matchingIndex = this.state.modelCycleChoices.findIndex(
            (choice) =>
                choice.selection.providerID === selection.providerID && choice.selection.modelID === selection.modelID,
        );
        if (matchingIndex >= 0) {
            this.state.modelCycleIndex = matchingIndex;
        }
        this.onModelCycleSelect?.(selection);
        this.publish();
    }

    cycleModel(direction: 1 | -1): void {
        const choices = this.state.modelCycleChoices;
        if (choices.length <= 1) return;
        const nextIndex = (this.state.modelCycleIndex + direction + choices.length) % choices.length;
        this.state.modelCycleIndex = nextIndex;
        const choice = choices[nextIndex];
        if (choice !== undefined) {
            // Cycle strips any prior variant: re-publish a base-only selection
            // so `currentModelVariantID` resets via `setModelSelection`.
            const baseSelection: ModelProviderSelection = {
                providerID: choice.selection.providerID,
                modelID: choice.selection.modelID,
            };
            this.setModelSelection(baseSelection);
        } else {
            this.publish();
        }
    }

    /**
     * Rotate the variant of the currently-selected base model through
     * `[unset, ...availableVariants]`. The `unset` slot clears `variantID`
     * from the selection (no variant shown). No-op when the current model has
     * no variants; in that case a notice is emitted so the user knows the
     * chord fired but had no effect.
     */
    showTransientNotice(message: string): void {
        this.transientNoticeCounter += 1;
        this.state.transientNotice = { id: this.transientNoticeCounter, message };
        this.publish();
    }

    cycleModelVariant(direction: 1 | -1): void {
        const baseSelection =
            this.state.currentModelSelection ?? this.state.modelCycleChoices[this.state.modelCycleIndex]?.selection;
        if (baseSelection === undefined) return;
        const variantChoices = createVariantChoices(baseSelection);
        if (variantChoices.length === 0) {
            this.showTransientNotice(`No variants for ${baseSelection.providerID}/${baseSelection.modelID}`);
            return;
        }
        const variantIDs = variantChoices
            .map((choice) => choice.selection.variantID)
            .filter((id): id is string => id !== undefined);
        const rotation: readonly (string | undefined)[] = [undefined, ...variantIDs];
        const currentIdx = rotation.indexOf(this.state.currentModelVariantID);
        const safeIdx = currentIdx >= 0 ? currentIdx : 0;
        const nextIdx = (safeIdx + direction + rotation.length) % rotation.length;
        const nextVariantID = rotation[nextIdx];
        const newSelection: ModelProviderSelection = {
            providerID: baseSelection.providerID,
            modelID: baseSelection.modelID,
            ...(nextVariantID !== undefined ? { variantID: nextVariantID } : {}),
        };
        this.setModelSelection(newSelection);
    }

    recallHistory(direction: 'up' | 'down', currentBuffer: string): string {
        const result =
            direction === 'up'
                ? navigateChatInputHistoryUp(this.state.history, currentBuffer)
                : navigateChatInputHistoryDown(this.state.history, currentBuffer);
        this.state.history = result.history;
        this.state.inputMirror = result.input;
        this.state.menuState = createSlashCommandMenuState();
        this.refreshFileAutocomplete();
        this.publish();
        return result.input;
    }

    navigateApproval(direction: 1 | -1): void {
        const count = APPROVAL_OPTIONS.length;
        this.state.approvalSelectedIndex = (this.state.approvalSelectedIndex + direction + count) % count;
        this.publish();
    }

    confirmApproval(): void {
        const selected = APPROVAL_OPTIONS[this.state.approvalSelectedIndex];
        this.state.overlayMode = 'none';
        this.publish();
        if (selected !== undefined) {
            this.enqueueEvent({ type: 'line', value: selected.key });
        }
    }

    denyApproval(): void {
        this.state.approvalSelectedIndex = APPROVAL_OPTIONS.length - 1;
        this.state.overlayMode = 'none';
        this.publish();
        this.enqueueEvent({ type: 'line', value: 'deny' });
    }

    navigateQuestion(direction: 1 | -1): void {
        const total = this.state.questionMultiple
            ? this.state.questionOptions.length
            : this.state.questionOptions.length + 1;
        this.state.questionSelectedIndex = (this.state.questionSelectedIndex + direction + total) % total;
        this.publish();
    }

    toggleQuestionOption(): void {
        const index = this.state.questionSelectedIndex;
        if (index >= this.state.questionOptions.length) return;
        const next = new Set(this.state.questionSelectedIndices);
        if (next.has(index)) {
            next.delete(index);
        } else {
            next.add(index);
        }
        this.state.questionSelectedIndices = next;
        this.publish();
    }

    /**
     * Single-select resolves immediately with the clicked label;
     * multi-select toggles membership (mirrors Enter vs Space). The trailing
     * custom-answer row enters custom-input mode.
     */
    selectQuestionByClick(index: number): void {
        if (index < 0) return;
        if (index >= this.state.questionOptions.length) {
            if (this.state.questionMultiple) return;
            this.state.questionSelectedIndex = index;
            this.state.questionCustomMode = true;
            this.state.questionCustomBuffer = '';
            this.publish();
            return;
        }
        this.state.questionSelectedIndex = index;
        if (this.state.questionMultiple) {
            const next = new Set(this.state.questionSelectedIndices);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            this.state.questionSelectedIndices = next;
            this.publish();
            return;
        }
        const selected = this.state.questionOptions[index];
        this.resolveQuestion(selected?.label ?? '');
    }

    enterQuestionCustomMode(): void {
        this.state.questionCustomMode = true;
        this.state.questionCustomBuffer = '';
        this.publish();
    }

    appendQuestionCustom(text: string): void {
        this.state.questionCustomBuffer += text;
        this.publish();
    }

    deleteQuestionCustomChar(): void {
        if (this.state.questionCustomBuffer.length === 0) return;
        this.state.questionCustomBuffer = this.state.questionCustomBuffer.slice(0, -1);
        this.publish();
    }

    exitQuestionCustomMode(): void {
        this.state.questionCustomMode = false;
        this.state.questionCustomBuffer = '';
        this.publish();
    }

    updateModelPickerKeypress(rawInput: string): void {
        const promptChoices = this.state.modelPickerChoices.map((choice) => ({
            id: choice.id,
            name: choice.label,
        }));
        this.state.modelPickerKeypress = reduceProviderPromptKeypress(
            this.state.modelPickerKeypress,
            rawInput,
            promptChoices,
        );
        this.publish();
    }

    updateSessionPickerSearch(rawInput: string): void {
        const promptChoices = this.state.sessionPickerEntries.map((entry) => ({
            id: entry.sessionId,
            name: entry.label,
        }));
        this.state.sessionPickerKeypress = reduceProviderPromptKeypress(
            this.state.sessionPickerKeypress,
            rawInput,
            promptChoices,
        );
        this.state.sessionPickerSelectedIndex = this.state.sessionPickerKeypress.selectedIndex;
        this.state.sessionPickerSearch = this.state.sessionPickerKeypress.searchQuery;
        this.publish();
    }

    confirmSessionPicker(): void {
        const view = createSessionPickerView(
            this.state.sessionPickerKeypress,
            this.state.sessionPickerEntries,
            Math.max(1, this.state.sessionPickerEntries.length),
        );
        const selected = view.filteredEntries[view.selectedIndex];
        if (selected !== undefined) {
            this.hideSessionPicker(selected.sessionId);
        } else {
            this.hideSessionPicker();
        }
    }

    cancelSessionPicker(): void {
        this.hideSessionPicker();
    }

    showAgentsDashboard(entries: readonly DashboardAgentEntry[]): void {
        this.state.agentsDashboard = {
            active: true,
            agents: entries,
            selectedIndex: 0,
            sourceTab: 'all',
            editingName: null,
            editBuffer: '',
        };
        this.state.overlayMode = 'agents-dashboard';
        this.publish();
    }

    hideAgentsDashboard(): void {
        this.state.agentsDashboard = {
            ...this.state.agentsDashboard,
            active: false,
            editingName: null,
            editBuffer: '',
        };
        this.state.overlayMode = 'none';
        this.publish();
    }

    navigateAgentsDashboard(delta: number): void {
        const filtered = this.filterAgentsBySourceTab();
        const count = filtered.length;
        if (count === 0) return;
        const next = this.state.agentsDashboard.selectedIndex + delta;
        this.state.agentsDashboard = {
            ...this.state.agentsDashboard,
            selectedIndex: Math.min(Math.max(next, 0), count - 1),
        };
        this.publish();
    }

    cycleAgentsDashboardSourceTab(delta: number): void {
        const tabs: readonly AgentsDashboardSourceTab[] = ['all', 'project', 'user', 'bundled'];
        const currentIdx = tabs.indexOf(this.state.agentsDashboard.sourceTab);
        const nextIdx = (currentIdx + delta + tabs.length) % tabs.length;
        this.state.agentsDashboard = {
            ...this.state.agentsDashboard,
            sourceTab: tabs[nextIdx] ?? 'all',
            selectedIndex: 0,
        };
        this.publish();
    }

    toggleAgentsDashboardAgentDisabled(name: string): void {
        this.state.agentsDashboard = {
            ...this.state.agentsDashboard,
            agents: this.state.agentsDashboard.agents.map((entry) =>
                entry.name === name ? { ...entry, disabled: !entry.disabled } : entry,
            ),
        };
        this.publish();
    }

    beginAgentsDashboardModelEdit(name: string): void {
        const entry = this.state.agentsDashboard.agents.find((a) => a.name === name);
        this.state.agentsDashboard = {
            ...this.state.agentsDashboard,
            editingName: name,
            editBuffer: entry?.overrideModel ?? entry?.model ?? '',
        };
        this.publish();
    }

    commitAgentsDashboardModelEdit(value: string | undefined): void {
        const name = this.state.agentsDashboard.editingName;
        if (name === null) return;
        this.state.agentsDashboard = {
            ...this.state.agentsDashboard,
            agents: applyAgentOverrideModel(this.state.agentsDashboard.agents, name, value),
            editingName: null,
            editBuffer: '',
        };
        this.publish();
    }

    cancelAgentsDashboardModelEdit(): void {
        this.state.agentsDashboard = {
            ...this.state.agentsDashboard,
            editingName: null,
            editBuffer: '',
        };
        this.publish();
    }

    reloadAgentsDashboard(entries: readonly DashboardAgentEntry[]): void {
        const selectedName = this.state.agentsDashboard.agents[this.state.agentsDashboard.selectedIndex]?.name;
        const newSelectedIndex =
            selectedName !== undefined
                ? Math.max(
                      0,
                      entries.findIndex((e) => e.name === selectedName),
                  )
                : 0;
        this.state.agentsDashboard = {
            ...this.state.agentsDashboard,
            agents: entries,
            selectedIndex: newSelectedIndex,
        };
        this.publish();
    }

    showModelsOverlay(entries: readonly ModelProviderSelection[], roleRows: readonly ModelsOverlayRoleRow[]): void {
        this.state.modelsOverlay = {
            active: true,
            entries,
            roleRows,
            activeLeftIndex: 0,
            activeRightIndex: 0,
            focusedColumn: 'left',
            searchQuery: '',
            activeProviderTab: 'all',
        };
        this.state.overlayMode = 'models-overlay';
        this.publish();
    }

    hideModelsOverlay(): void {
        this.state.modelsOverlay = { ...this.state.modelsOverlay, active: false };
        this.state.overlayMode = 'none';
        this.publish();
    }

    navigateModelsOverlay(direction: 1 | -1): void {
        const state = this.buildModelsOverlayState();
        if (state === null) return;
        const next = direction < 0 ? navigateModelsOverlayUp(state) : navigateModelsOverlayDown(state);
        this.state.modelsOverlay = {
            ...this.state.modelsOverlay,
            activeLeftIndex: next.activeLeftIndex,
            activeRightIndex: next.activeRightIndex,
        };
        this.publish();
    }

    switchModelsOverlayColumn(): void {
        const state = this.buildModelsOverlayState();
        if (state === null) return;
        const next = reduceModelsOverlayColumn(state);
        this.state.modelsOverlay = {
            ...this.state.modelsOverlay,
            focusedColumn: next.focusedColumn,
        };
        this.publish();
    }

    async assignModelsOverlayRole(role: ModelRole, selection: ModelProviderSelection): Promise<void> {
        this.state.modelsOverlay = {
            ...this.state.modelsOverlay,
            roleRows: this.state.modelsOverlay.roleRows.map((row) =>
                row.role === role ? { ...row, assignment: selection } : row,
            ),
        };
        this.publish();
        if (this.authStore !== undefined) {
            await this.authStore.setModelRole(role, selection);
        }
    }

    async clearModelsOverlayRole(role: ModelRole): Promise<void> {
        this.state.modelsOverlay = {
            ...this.state.modelsOverlay,
            roleRows: this.state.modelsOverlay.roleRows.map((row) =>
                row.role === role ? { ...row, assignment: undefined } : row,
            ),
        };
        this.publish();
        if (this.authStore !== undefined) {
            await this.authStore.clearModelRole(role);
        }
    }

    setModelsOverlaySearchQuery(query: string): void {
        const state = this.buildModelsOverlayState();
        if (state === null) return;
        const next = reduceModelsOverlaySearchQuery(state, query);
        this.state.modelsOverlay = {
            ...this.state.modelsOverlay,
            searchQuery: next.searchQuery,
            activeLeftIndex: next.activeLeftIndex,
        };
        this.publish();
    }

    setModelsOverlayProviderTab(tabId: string): void {
        const state = this.buildModelsOverlayState();
        if (state === null) return;
        const next = reduceModelsOverlayProviderTab(state, tabId);
        this.state.modelsOverlay = {
            ...this.state.modelsOverlay,
            activeProviderTab: next.activeProviderTab,
            activeLeftIndex: next.activeLeftIndex,
        };
        this.publish();
    }

    private buildModelsOverlayState(): ModelsOverlayState | null {
        const slice = this.state.modelsOverlay;
        if (slice.roleRows.length === 0) return null;
        return {
            leftEntries: slice.entries,
            roleRows: slice.roleRows,
            activeLeftIndex: slice.activeLeftIndex,
            activeRightIndex: slice.activeRightIndex,
            focusedColumn: slice.focusedColumn,
            searchQuery: slice.searchQuery,
            activeProviderTab: slice.activeProviderTab,
        };
    }

    private filterAgentsBySourceTab(): readonly DashboardAgentEntry[] {
        const tab = this.state.agentsDashboard.sourceTab;
        return tab === 'all'
            ? this.state.agentsDashboard.agents
            : this.state.agentsDashboard.agents.filter((a) => a.source === tab);
    }

    navigateLevelPicker(direction: 1 | -1): void {
        const count = APPROVAL_LEVELS.length;
        this.state.levelPickerSelectedIndex = (this.state.levelPickerSelectedIndex + direction + count) % count;
        this.publish();
    }

    appendRenameChar(text: string): void {
        this.state.renameBuffer += text;
        this.publish();
    }

    deleteRenameChar(): void {
        if (this.state.renameBuffer.length === 0) return;
        this.state.renameBuffer = this.state.renameBuffer.slice(0, -1);
        this.publish();
    }

    cancelRename(): void {
        this.state.overlayMode = 'none';
        this.state.renameBuffer = '';
        this.publish();
    }

    submitLine(value: string): void {
        this.enqueueEvent({ type: 'line', value });
        this.state.history = recordSubmittedPrompt(this.state.history, value);
        if (!value.startsWith('/')) {
            this.state.outputText += `You: ${value}\n`;
        }
        this.state.pasteStore.clear();
        this.state.inputMirror = '';
        this.state.menuState = createSlashCommandMenuState();
        this.state.fileAutocomplete = createFileAutocompleteState();
        this.publish();
    }

    openDiffViewer(entries: readonly DiffEntry[]): void {
        this.state.diffViewerEntries = entries;
        this.state.diffViewerCursor = 0;
        this.state.overlayMode = 'diff-viewer';
        this.publish();
    }

    sendInterrupt(source: 'esc' | 'ctrl-c'): void {
        this.enqueueEvent({ type: 'interrupt', interruptedPartialInput: false, source });
        this.publish();
    }

    sendSlashCommand(command: string): void {
        this.enqueueEvent({ type: 'line', value: command });
        this.publish();
    }

    registerPaste(text: string): number {
        this.state.pasteCounter += 1;
        const id = this.state.pasteCounter;
        this.state.pasteStore.store(id, text);
        return id;
    }

    private publish(): void {
        this.snapshot = this.buildSnapshot();
        for (const listener of this.listeners) {
            listener();
        }
    }

    private buildSnapshot(): ChatStoreState {
        return {
            ...this.state,
            historyNavigation: isNavigatingChatInputHistory(this.state.history)
                ? { position: this.state.history.cursor + 1, total: this.state.history.entries.length }
                : null,
        };
    }

    private refreshFileAutocomplete(): void {
        const prefix = readActiveFilePrefix(this.state.inputMirror);
        if (prefix === undefined) {
            this.state.fileAutocomplete = createFileAutocompleteState();
            return;
        }
        this.state.fileAutocomplete = updateFileAutocomplete(this.state.fileAutocomplete, prefix, this.workspaceRoot);
    }
}

export function createSessionPickerView(
    state: ProviderPromptKeypressState,
    entries: readonly SessionPickerEntry[],
    maxVisibleEntries: number,
): SessionPickerView {
    const visibleLimit = Math.max(1, maxVisibleEntries);
    const promptChoices = entries.map((entry) => ({ id: entry.sessionId, name: entry.label }));
    const filteredChoices = filterProviderPromptChoices(promptChoices, state.searchQuery);
    const filteredIds = new Set(filteredChoices.map((choice) => choice.id));
    const filteredEntries = entries.filter((entry) => filteredIds.has(entry.sessionId));
    const totalCount = filteredEntries.length;
    const selectedIndex = totalCount <= 0 ? 0 : Math.min(Math.max(state.selectedIndex, 0), totalCount - 1);
    const startIndex =
        totalCount <= visibleLimit
            ? 0
            : Math.min(Math.max(selectedIndex - Math.floor(visibleLimit / 2), 0), totalCount - visibleLimit);
    const endIndex = Math.min(totalCount, startIndex + visibleLimit);
    return {
        filteredEntries,
        visibleEntries: filteredEntries.slice(startIndex, endIndex),
        selectedIndex,
        startIndex,
        endIndex,
        totalCount,
        searchQuery: state.searchQuery,
    };
}

export function createChatStore(options?: ChatStoreOptions): ChatStore {
    return new ChatStore(options);
}

function applyAgentOverrideModel(
    agents: readonly DashboardAgentEntry[],
    name: string,
    value: string | undefined,
): readonly DashboardAgentEntry[] {
    return agents.map((entry) => {
        if (entry.name !== name) return entry;
        if (value !== undefined) {
            return { ...entry, overrideModel: value };
        }
        const rebuilt: DashboardAgentEntry = {
            name: entry.name,
            description: entry.description,
            source: entry.source,
            disabled: entry.disabled,
            ...(entry.model !== undefined ? { model: entry.model } : {}),
            ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
            ...(entry.filePath !== undefined ? { filePath: entry.filePath } : {}),
        };
        return rebuilt;
    });
}

export function createAgentsDashboardView(state: AgentsDashboardState, maxVisible: number): AgentsDashboardView {
    const visibleLimit = Math.max(1, maxVisible);
    const agents = state.agents;
    const sourceTabs: AgentsDashboardSourceTabInfo[] = [
        { id: 'all', label: 'All', count: agents.length },
        { id: 'project', label: 'Project', count: agents.filter((a) => a.source === 'project').length },
        { id: 'user', label: 'User', count: agents.filter((a) => a.source === 'user').length },
        { id: 'bundled', label: 'Bundled', count: agents.filter((a) => a.source === 'bundled').length },
    ];
    const filteredEntries = state.sourceTab === 'all' ? agents : agents.filter((a) => a.source === state.sourceTab);
    const totalCount = filteredEntries.length;
    const selectedIndex = totalCount <= 0 ? 0 : Math.min(Math.max(state.selectedIndex, 0), totalCount - 1);
    const startIndex =
        totalCount <= visibleLimit
            ? 0
            : Math.min(Math.max(selectedIndex - Math.floor(visibleLimit / 2), 0), totalCount - visibleLimit);
    const visibleCount = Math.min(visibleLimit, totalCount);
    const endIndex = totalCount === 0 ? 0 : startIndex + visibleCount - 1;
    const visibleEntries = totalCount === 0 ? [] : filteredEntries.slice(startIndex, endIndex + 1);
    const inspectorEntry = totalCount === 0 ? null : (filteredEntries[selectedIndex] ?? null);
    return {
        sourceTabs,
        visibleEntries,
        selectedIndex,
        startIndex,
        endIndex,
        totalCount,
        inspectorEntry,
    };
}
