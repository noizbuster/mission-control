// allow: SIZE_OK — indivisible reactive store; the 35-field state shape and
// matching initial-state literal are pure data tables dictated by the bridge
// core contract, and every action mutates the same state object.
import { type ModelProviderSelection } from '@mission-control/protocol';
import { type ApprovalLevel, APPROVAL_LEVELS, isApprovalLevel } from './approval-level.js';
import type { ChatInputEvent } from './interactive-chat-io.js';
import type { ModelChoice } from './interactive-chat-model.js';
import {
    type SlashCommandMenuState,
    createSlashCommandMenuState,
    reduceSlashCommandMenuSelection,
    reduceWorkflowCommandMenuSelection,
} from './interactive-chat-command-menu.js';
import {
    type FileAutocompleteState,
    createFileAutocompleteState,
    navigateFileAutocompleteDown,
    navigateFileAutocompleteUp,
    updateFileAutocomplete,
} from './interactive-chat-file-autocomplete.js';
import {
    type ProviderPromptKeypressState,
    createProviderPromptKeypressState,
    filterProviderPromptChoices,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';
import {
    type ChatInputHistory,
    createChatInputHistory,
    createChatInputHistoryFromEntries,
    isNavigatingChatInputHistory,
    navigateChatInputHistoryDown,
    navigateChatInputHistoryUp,
    recordSubmittedPrompt,
} from './interactive-chat-input-history.js';
import { type QuestionOption, normalizeQuestionOptions } from './question-types.js';
import type { DiffEntry } from '../platform/keymap/diff-viewer.js';
import { PasteMarkerStore } from '../platform/keymap/bracketed-paste.js';

export type ChatStoreOverlayMode =
    | 'none'
    | 'model-picker'
    | 'level-picker'
    | 'approval'
    | 'question'
    | 'rename'
    | 'abg'
    | 'diff-viewer'
    | 'session-picker';

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
    readonly inputMirror: string;
    readonly generating: boolean;
    readonly agentStatusText: string;
    readonly showThinking: boolean;
    readonly toolOutputExpanded: boolean;
    readonly approvalLevel: ApprovalLevel | undefined;
    readonly workflowNames: readonly string[];
    readonly modelCycleChoices: readonly ModelChoice[];
    readonly modelCycleIndex: number;
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
    readonly historyNavigation: { readonly position: number; readonly total: number } | null;
};

type ChatStoreMutableState = {
    -readonly [K in keyof Omit<ChatStoreState, 'historyNavigation'>]: Omit<ChatStoreState, 'historyNavigation'>[K];
};

export type ChatStoreOptions = {
    readonly workspaceRoot?: string;
    readonly initialHistoryEntries?: readonly string[];
    readonly initialApprovalLevel?: ApprovalLevel;
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

export const APPROVAL_LEVEL_PICKER_ENTRIES: readonly { readonly id: string; readonly label: string; readonly desc: string }[] = [
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

    constructor(options?: ChatStoreOptions) {
        this.workspaceRoot = options?.workspaceRoot ?? process.cwd();
        const history =
            options?.initialHistoryEntries !== undefined
                ? createChatInputHistoryFromEntries(options.initialHistoryEntries)
                : createChatInputHistory();
        this.state = {
            outputText: '',
            inputMirror: '',
            generating: false,
            agentStatusText: '',
            showThinking: true,
            toolOutputExpanded: false,
            approvalLevel: options?.initialApprovalLevel,
            workflowNames: [],
            modelCycleChoices: [],
            modelCycleIndex: 0,
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
        this.state.renameBuffer = '';
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
        if (this.state.modelCycleIndex >= choices.length) {
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

    cycleModel(direction: 1 | -1): void {
        const choices = this.state.modelCycleChoices;
        if (choices.length <= 1) return;
        this.state.modelCycleIndex =
            (this.state.modelCycleIndex + direction + choices.length) % choices.length;
        const choice = choices[this.state.modelCycleIndex];
        if (choice !== undefined) {
            this.onModelCycleSelect?.(choice.selection);
        }
        this.publish();
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
        this.state.approvalSelectedIndex =
            (this.state.approvalSelectedIndex + direction + count) % count;
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
        this.state.questionSelectedIndex =
            (this.state.questionSelectedIndex + direction + total) % total;
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

    navigateLevelPicker(direction: 1 | -1): void {
        const count = APPROVAL_LEVELS.length;
        this.state.levelPickerSelectedIndex =
            (this.state.levelPickerSelectedIndex + direction + count) % count;
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
