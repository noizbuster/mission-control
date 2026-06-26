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
import { type ProviderPromptKeypressState, createProviderPromptKeypressState } from './auth-provider-keypress.js';
import {
    type ChatInputHistory,
    createChatInputHistory,
    createChatInputHistoryFromEntries,
    isNavigatingChatInputHistory,
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
    | 'diff-viewer';

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

const WHITESPACE_PATTERN = /\s/u;
const EMIT_COALESCE_MS = 16;
const CURSOR_UP = '\u001b[A';
const CURSOR_DOWN = '\u001b[B';
const APPROVAL_LEVEL_DEFAULT_INDEX = 1;

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

export function createChatStore(options?: ChatStoreOptions): ChatStore {
    return new ChatStore(options);
}
