// allow: SIZE_OK -- HEAD 1593 -> current 1780 pure LOC; one reactive ChatStore owns the bridge state table and actions that mutate the same state object.

import type { ProviderAuthStore } from '@mission-control/core';
import { type ModelProviderSelection, type ModelRole } from '@mission-control/protocol';
import { normalizeQuestionOptions, type QuestionBatchEntry, type QuestionOption } from '@mission-control/tui/chat';
import { PasteMarkerStore } from '../platform/keymap/bracketed-paste';
import type { DiffEntry } from '../platform/keymap/diff-viewer';
import { APPROVAL_LEVELS, type ApprovalLevel, isApprovalLevel } from './approval-level';
import {
    appendProviderPromptSearch,
    createProviderPromptKeypressState,
    filterProviderPromptChoices,
    type ProviderPromptKeypressState,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress';
import type { ChatInputEvent } from './chat-input-event';
import {
    clampHistoryPickerSelection,
    closeHistoryPicker,
    createHistoryPickerState,
    type HistoryPickerEntry,
    type HistoryPickerState,
    navigateHistoryPicker as reduceHistoryPickerNavigation,
    openHistoryPicker as reduceOpenHistoryPicker,
} from './history-picker-state';
import {
    createSlashCommandMenuState,
    reduceSkillCommandMenuSelection,
    reduceSlashCommandMenuSelection,
    reduceWorkflowCommandMenuSelection,
    type SlashCommandMenuState,
} from './interactive-chat-command-menu';
import {
    createFileAutocompleteState,
    type FileAutocompleteState,
    navigateFileAutocompleteDown,
    navigateFileAutocompleteUp,
    updateFileAutocomplete,
} from './interactive-chat-file-autocomplete';
import { createVariantChoices, type ModelChoice } from './interactive-chat-model';
import {
    type ModelsOverlayRoleRow,
    type ModelsOverlayState,
    navigateModelsOverlayDown,
    navigateModelsOverlayUp,
    switchModelsOverlayColumn as reduceModelsOverlayColumn,
    setModelsOverlayProviderTab as reduceModelsOverlayProviderTab,
    setModelsOverlaySearchQuery as reduceModelsOverlaySearchQuery,
    selectModelForAssignment as selectModelForAssignmentReducer,
} from './models-overlay-state';
import { sanitizeTerminalDisplayText } from './terminal-display-sanitizer';
import { extractOccurrenceNumber, type TranscriptPart, upsertTranscriptPart } from './transcript-part';
import { activeAssistantMessageIdFromParts, attributionKeyForAssistantPart } from './transcript-visibility';

export type { HistoryPickerEntry, HistoryPickerState } from './history-picker-state';

export type HistoryPickerSnapshot = {
    readonly open: boolean;
    readonly selectedIndex: number;
    readonly total: number;
    readonly draftSnapshot: string;
};

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
    | 'models-overlay'
    | 'mission-panel';

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
    readonly pendingAssignModel: ModelProviderSelection | null;
};

export type MissionPanelTab = 'runs' | 'jobs' | 'agents' | 'drain' | 'continue';

export type MissionPanelRow = {
    readonly id: string;
    readonly label: string;
    readonly status?: string;
    readonly detail?: string;
};

/** Slice backing the mission panel overlay. `rows` is the pluggable data source
 *  (stubbed empty until later todos wire real Mission/Run stores). `loadedAt`
 *  and `count` are reload metadata captured whenever the panel is shown or
 *  `reloadMissions` runs. Mirrors the `AgentsDashboardState` snapshot/publish
 *  discipline: every mutation spreads the slice and calls `publish()`. */
export type MissionPanelState = {
    readonly active: boolean;
    readonly activeTab: MissionPanelTab;
    readonly rows: readonly MissionPanelRow[];
    readonly selectedIndex: number;
    readonly loadedAt: string | null;
    readonly count: number;
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

/** Cumulative cache accounting for graph LLM turns in the attached session. */
export type ContextCacheUsage = {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
};

export type ChatStoreState = {
    readonly outputText: string;
    readonly transcriptParts: readonly TranscriptPart[];
    /**
     * Attribution key of the latest assistant turn (`messageId ?? requestId ?? id`).
     * Used to hide past successful tool/diff satellites into Element B chips.
     */
    readonly activeAssistantMessageId: string | undefined;
    readonly sessionId: string;
    /** Live session display name; rename overlay falls back to `sessionId` when this is empty. */
    readonly sessionDisplayName: string;
    readonly inputMirror: string;
    readonly generating: boolean;
    readonly agentStatusText: string;
    readonly agentRetryAt: number | undefined;
    readonly showThinking: boolean;
    /** Tool output expansion (Ctrl+O). */
    readonly toolOutputExpanded: boolean;
    readonly approvalLevel: ApprovalLevel | undefined;
    readonly workflowNames: readonly string[];
    readonly skillNames: readonly string[];
    readonly modelCycleChoices: readonly ModelChoice[];
    readonly modelCycleIndex: number;
    /** Single source of truth for the live selection; `setModelSelection` keeps `modelCycleIndex` aligned when the base matches a cycle entry. */
    readonly currentModelSelection: ModelProviderSelection | undefined;
    /** Mirror of `currentModelSelection.variantID`; used by `cycleModelVariant` to find its rotation slot. */
    readonly currentModelVariantID: string | undefined;
    readonly menuState: SlashCommandMenuState;
    readonly fileAutocomplete: FileAutocompleteState;
    readonly historyEntries: readonly HistoryPickerEntry[];
    readonly historyPicker: HistoryPickerState;
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
    readonly questionTabs: readonly QuestionBatchEntry[];
    readonly questionTabIndex: number;
    readonly questionAnswers: readonly (readonly string[])[];
    readonly questionConfirmActive: boolean;
    readonly modelPickerChoices: readonly ModelChoice[];
    readonly modelPickerKeypress: ProviderPromptKeypressState;
    readonly levelPickerSelectedIndex: number;
    readonly renameBuffer: string;
    readonly abgOverlayActiveTab: number;
    readonly abgOverlayScrollOffset: number;
    readonly abgOverlayLiveOutput: boolean;
    /** Session-local minimap visibility (NOT persisted in AbgOverlayPrefsSchema). */
    readonly abgMinimapVisible: boolean;
    readonly diffViewerEntries: readonly DiffEntry[];
    readonly diffViewerCursor: number;
    readonly sessionPickerEntries: readonly SessionPickerEntry[];
    readonly sessionPickerSelectedIndex: number;
    readonly sessionPickerSearch: string;
    readonly sessionPickerKeypress: ProviderPromptKeypressState;
    readonly agentsDashboard: AgentsDashboardState;
    readonly modelsOverlay: ModelsOverlaySlice;
    readonly missionPanel: MissionPanelState;
    readonly contextTokensUsed: number | undefined;
    readonly contextTokensMax: number | undefined;
    readonly contextCacheUsage: ContextCacheUsage | undefined;
    readonly historyPickerView: HistoryPickerSnapshot;
    readonly transientNotice: { readonly id: number; readonly message: string } | null;
    readonly stickyNotice: string | null;
};

type ChatStoreMutableState = {
    -readonly [K in keyof Omit<ChatStoreState, 'historyPickerView'>]: Omit<ChatStoreState, 'historyPickerView'>[K];
};

export type ChatStoreOptions = {
    readonly workspaceRoot?: string;
    readonly initialHistoryEntries?: readonly HistoryPickerEntry[];
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
const SUBMITTED_USER_PART_ID_PATTERN = /^submitted-user-(0|[1-9][0-9]*)$/u;
const EMIT_COALESCE_MS = 16;
// 20fps visible update during streaming; halves render frequency vs 16ms to keep
// the main thread responsive for keyboard input while tokens pour in.
const STREAMING_EMIT_COALESCE_MS = 50;
// Sliding-window caps. Without these, long streaming sessions with parallel subagent
// fan-out accumulate parts and text forever, driving native TextBuffer pressure.
// Full history remains in the durable session DB; the in-memory store is for live view.
const MAX_TRANSCRIPT_PARTS = 500;
const MAX_OUTPUT_TEXT_CHARS = 256 * 1024;
const MAX_HISTORY_ENTRIES = 1000;
const CURSOR_UP = '\u001b[A';
const CURSOR_DOWN = '\u001b[B';
const APPROVAL_LEVEL_DEFAULT_INDEX = 1;

/** Concatenate `current + text`, dropping the head when the result exceeds `maxChars`. Keeps the most recent tail so live UI stays meaningful; full text remains in the durable session DB. */
function appendClamped(current: string, text: string, maxChars: number): string {
    const next = current + text;
    return next.length > maxChars ? next.slice(next.length - maxChars) : next;
}

/** Drop the oldest transcript parts when over cap. Preserves insertion order of the tail. */
function clampTranscriptParts(parts: readonly TranscriptPart[]): readonly TranscriptPart[] {
    return parts.length > MAX_TRANSCRIPT_PARTS ? parts.slice(parts.length - MAX_TRANSCRIPT_PARTS) : parts;
}

function sanitizeQuestionOptionForDisplay(option: QuestionOption): QuestionOption {
    return {
        label: sanitizeTerminalDisplayText(option.label),
        ...(option.description === undefined ? {} : { description: sanitizeTerminalDisplayText(option.description) }),
    };
}

function sanitizeQuestionBatchEntryForDisplay(entry: QuestionBatchEntry): QuestionBatchEntry {
    return {
        question: sanitizeTerminalDisplayText(entry.question),
        header: sanitizeTerminalDisplayText(entry.header),
        options: entry.options.map(sanitizeQuestionOptionForDisplay),
        multiple: entry.multiple,
    };
}

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
    private fileFrecencyKeys: readonly string[] = [];
    private modelPickerResolve: ((selection: ModelProviderSelection | undefined) => void) | undefined;
    private levelPickerResolve: ((level: string | undefined) => void) | undefined;
    private questionResolve: ((answer: string) => void) | undefined;
    private questionBatchResolve: ((answers: string[]) => void) | undefined;
    private rawQuestionText = '';
    private rawQuestionHeader = '';
    private rawQuestionOptions: readonly QuestionOption[] = [];
    private rawQuestionCustomBuffer = '';
    private rawQuestionTabs: readonly QuestionBatchEntry[] = [];
    private rawQuestionAnswers: readonly (readonly string[])[] = [];
    private sessionPickerResolve: ((sessionId: string | undefined) => void) | undefined;
    private scheduledPublishTimeout: ReturnType<typeof setTimeout> | undefined;
    private publishGeneration = 0;
    private transientNoticeCounter = 0;
    private historyEntryCounter = 0;
    private submittedUserPartCounter = 0;
    private legacyPartCounter = 0;

    constructor(options?: ChatStoreOptions) {
        this.workspaceRoot = options?.workspaceRoot ?? process.cwd();
        this.authStore = options?.authStore;
        const historyEntries = options?.initialHistoryEntries !== undefined ? [...options.initialHistoryEntries] : [];
        this.state = {
            outputText: '',
            transcriptParts: [],
            activeAssistantMessageId: undefined,
            sessionId: '',
            sessionDisplayName: '',
            inputMirror: '',
            generating: false,
            agentStatusText: '',
            agentRetryAt: undefined,
            showThinking: true,
            // Tool output is collapsed until Ctrl+O.
            toolOutputExpanded: false,
            approvalLevel: options?.initialApprovalLevel,
            workflowNames: [],
            skillNames: [],
            modelCycleChoices: [],
            modelCycleIndex: 0,
            currentModelSelection: undefined,
            currentModelVariantID: undefined,
            menuState: createSlashCommandMenuState(),
            fileAutocomplete: createFileAutocompleteState(),
            historyEntries,
            historyPicker: createHistoryPickerState(),
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
            questionTabs: [],
            questionTabIndex: 0,
            questionAnswers: [],
            questionConfirmActive: false,
            modelPickerChoices: [],
            modelPickerKeypress: createProviderPromptKeypressState(),
            levelPickerSelectedIndex: 0,
            renameBuffer: '',
            abgOverlayActiveTab: 0,
            abgOverlayScrollOffset: 0,
            abgOverlayLiveOutput: false,
            abgMinimapVisible: false,
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
                pendingAssignModel: null,
            },
            missionPanel: {
                active: false,
                activeTab: 'runs',
                rows: [],
                selectedIndex: 0,
                loadedAt: null,
                count: 0,
            },
            contextTokensUsed: undefined,
            contextTokensMax: undefined,
            contextCacheUsage: undefined,
            transientNotice: null,
            stickyNotice: null,
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
        this.state.outputText = appendClamped(this.state.outputText, text, MAX_OUTPUT_TEXT_CHARS);
        if (this.hasTypedTranscriptParts()) {
            this.appendLegacyTranscriptPart(text);
        }
        const ms = this.state.generating ? STREAMING_EMIT_COALESCE_MS : EMIT_COALESCE_MS;
        this.schedulePublish(ms);
    }

    replaceOutputText(text: string): void {
        this.state.outputText = text;
        this.state.transcriptParts = [];
        this.legacyPartCounter = 0;
        this.publish();
    }

    emitTranscriptPart(part: TranscriptPart, fallbackText: string): void {
        this.appendTypedTranscriptPart(part);
        this.state.outputText = appendClamped(this.state.outputText, fallbackText, MAX_OUTPUT_TEXT_CHARS);
        if ('status' in part && part.status === 'streaming') {
            this.schedulePublish(STREAMING_EMIT_COALESCE_MS);
            return;
        }
        this.publish();
    }

    emitTranscriptFallback(text: string): void {
        this.state.outputText = appendClamped(this.state.outputText, text, MAX_OUTPUT_TEXT_CHARS);
        const ms = this.state.generating ? STREAMING_EMIT_COALESCE_MS : EMIT_COALESCE_MS;
        this.schedulePublish(ms);
    }

    replaceTranscript(parts: readonly TranscriptPart[], outputText: string): void {
        this.state.transcriptParts = parts;
        this.state.outputText = outputText;
        this.state.activeAssistantMessageId = activeAssistantMessageIdFromParts(parts);
        this.submittedUserPartCounter = parts.reduce((highestOccurrence, part) => {
            const occurrenceText = SUBMITTED_USER_PART_ID_PATTERN.exec(part.id)?.[1];
            if (occurrenceText === undefined) return highestOccurrence;
            const occurrence = Number(occurrenceText);
            return Number.isSafeInteger(occurrence) ? Math.max(highestOccurrence, occurrence) : highestOccurrence;
        }, 0);
        this.legacyPartCounter = 0;
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
        this.clearRawQuestionState();
        this.rawQuestionText = question;
        this.rawQuestionHeader = metadata?.header ?? '';
        this.rawQuestionOptions = normalizeQuestionOptions(options);
        this.state.overlayMode = 'question';
        this.state.questionText = sanitizeTerminalDisplayText(this.rawQuestionText);
        this.state.questionHeader = sanitizeTerminalDisplayText(this.rawQuestionHeader);
        this.state.questionOptions = this.rawQuestionOptions.map(sanitizeQuestionOptionForDisplay);
        this.state.questionSelectedIndex = 0;
        this.state.questionMultiple = metadata?.multiple ?? false;
        this.state.questionSelectedIndices = new Set<number>();
        this.state.questionCustomMode = false;
        this.state.questionCustomBuffer = '';
        this.state.questionTabs = [];
        this.state.questionTabIndex = 0;
        this.setQuestionAnswers([]);
        this.state.questionConfirmActive = false;
        this.publish();
        return new Promise<string>((resolve) => {
            this.questionResolve = resolve;
        });
    }

    /** Multi-question batch as ONE tabbed overlay (opencode-style). A lone
     * non-multiple question resolves immediately with no tabs; otherwise a
     * trailing Confirm tab is added. Resolves with one answer string per
     * question (multi-select comma-joined), in order. */
    showQuestionBatch(entries: readonly QuestionBatchEntry[]): Promise<string[]> {
        this.clearRawQuestionState();
        this.rawQuestionTabs = entries.map((entry) => ({ ...entry, options: normalizeQuestionOptions(entry.options) }));
        this.state.overlayMode = 'question';
        this.state.questionTabs = this.rawQuestionTabs.map(sanitizeQuestionBatchEntryForDisplay);
        this.state.questionTabIndex = 0;
        this.setQuestionAnswers(this.rawQuestionTabs.map((): string[] => []));
        this.state.questionConfirmActive = false;
        this.loadQuestionTab(0);
        this.publish();
        return new Promise<string[]>((resolve) => {
            this.questionBatchResolve = resolve;
        });
    }

    private loadQuestionTab(index: number): void {
        const rawTab = this.rawQuestionTabs[index];
        const displayTab = this.state.questionTabs[index];
        if (rawTab === undefined || displayTab === undefined) return;
        this.rawQuestionText = rawTab.question;
        this.rawQuestionHeader = rawTab.header;
        this.rawQuestionOptions = rawTab.options;
        this.state.questionText = displayTab.question;
        this.state.questionHeader = displayTab.header;
        this.state.questionOptions = displayTab.options;
        this.state.questionMultiple = rawTab.multiple;
        this.state.questionSelectedIndex = 0;
        const labels = this.rawQuestionAnswers[index] ?? [];
        const indices = new Set<number>();
        for (const label of labels) {
            const optIdx = rawTab.options.findIndex((option) => option.label === label);
            if (optIdx >= 0) indices.add(optIdx);
        }
        this.state.questionSelectedIndices = indices;
        this.state.questionCustomMode = false;
        this.state.questionCustomBuffer = '';
        this.rawQuestionCustomBuffer = '';
    }

    /** Tabs + Confirm show when N>1 OR any question is multiple-select. */
    private multiQuestionBatch(): boolean {
        const tabs = this.state.questionTabs;
        return tabs.length > 1 || (tabs.length === 1 && tabs[0]?.multiple === true);
    }

    private questionTabCount(): number {
        return this.multiQuestionBatch() ? this.state.questionTabs.length + 1 : this.state.questionTabs.length;
    }

    navigateQuestionTab(direction: 1 | -1): void {
        if (this.state.questionTabs.length === 0 || !this.multiQuestionBatch()) return;
        const total = this.questionTabCount();
        this.state.questionTabIndex = (this.state.questionTabIndex + direction + total) % total;
        this.state.questionConfirmActive = this.state.questionTabIndex === this.state.questionTabs.length;
        if (!this.state.questionConfirmActive) {
            this.loadQuestionTab(this.state.questionTabIndex);
        }
        this.publish();
    }

    selectQuestionTab(index: number): void {
        if (this.state.questionTabs.length === 0 || !this.multiQuestionBatch()) return;
        const total = this.questionTabCount();
        if (index < 0 || index >= total) return;
        this.state.questionTabIndex = index;
        this.state.questionConfirmActive = index === this.state.questionTabs.length;
        if (!this.state.questionConfirmActive) {
            this.loadQuestionTab(index);
        }
        this.publish();
    }

    hoverQuestionTab(index: number): void {
        this.selectQuestionTab(index);
    }

    /** Single-select pick: record the answer, then advance — or resolve at
     * once for a lone non-multiple question. */
    private pickQuestionAnswer(label: string): void {
        const idx = this.state.questionTabIndex;
        if (idx < this.rawQuestionTabs.length) {
            this.setQuestionAnswers(this.rawQuestionAnswers.map((answers, i) => (i === idx ? [label] : answers)));
        }
        if (!this.multiQuestionBatch()) {
            this.resolveQuestionBatch([label]);
            return;
        }
        this.navigateQuestionTab(1);
    }

    /** Resolve the batch (multi-select answers comma-joined). Confirm-tab Enter. */
    confirmQuestionBatch(): void {
        const answers = this.rawQuestionAnswers.map((labels) => labels.join(', '));
        this.resolveQuestionBatch(answers);
    }

    /** Cancel: resolve single with '', or the whole batch with empty answers. */
    rejectQuestion(): void {
        if (this.rawQuestionTabs.length > 0) {
            this.resolveQuestionBatch(this.rawQuestionTabs.map((): string => ''));
            return;
        }
        this.resolveQuestion('');
    }

    private resolveQuestionBatch(answers: string[]): void {
        const resolve = this.questionBatchResolve;
        this.questionBatchResolve = undefined;
        this.state.overlayMode = 'none';
        this.state.questionTabs = [];
        this.state.questionAnswers = [];
        this.state.questionConfirmActive = false;
        this.clearRawQuestionState();
        this.publish();
        resolve?.(answers);
    }

    resolveQuestion(answer: string): void {
        const rawAnswer = this.rawQuestionAnswerForDisplay(answer);
        const resolve = this.questionResolve;
        this.questionResolve = undefined;
        this.state.overlayMode = 'none';
        this.clearRawQuestionState();
        this.publish();
        resolve?.(rawAnswer);
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

    setContextCacheUsage(usage: ContextCacheUsage | undefined): void {
        this.state.contextCacheUsage = usage;
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

    navigateSkillMenu(direction: 'up' | 'down'): void {
        this.state.menuState = reduceSkillCommandMenuSelection(
            this.state.menuState,
            direction === 'up' ? CURSOR_UP : CURSOR_DOWN,
            this.state.inputMirror,
            this.state.skillNames,
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
        this.state.agentRetryAt = undefined;
        this.publish();
    }

    setAgentRetryStatus(text: string, retryAt: number): void {
        this.state.agentStatusText = text;
        this.state.agentRetryAt = retryAt;
        this.publish();
    }

    clearAgentStatus(): void {
        this.state.agentStatusText = '';
        this.state.agentRetryAt = undefined;
        this.publish();
    }

    setWorkflowNames(names: readonly string[]): void {
        this.state.workflowNames = names;
        this.publish();
    }

    setSkillNames(names: readonly string[]): void {
        this.state.skillNames = names;
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

    toggleAbgMinimap(): void {
        this.state.abgMinimapVisible = !this.state.abgMinimapVisible;
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

    setStickyNotice(message: string | null): void {
        if (this.state.stickyNotice === message) return;
        this.state.stickyNotice = message;
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

    setHistoryEntries(entries: readonly HistoryPickerEntry[]): void {
        this.state.historyEntries = [...entries];
        this.state.historyPicker = createHistoryPickerState();
        this.publish();
    }

    historyEntriesNewestFirst(): readonly HistoryPickerEntry[] {
        return reverseHistoryEntries(this.state.historyEntries);
    }

    isHistoryPickerOpen(): boolean {
        return this.state.historyPicker.open;
    }

    openHistoryPicker(currentBuffer: string): void {
        if (this.state.historyPicker.open) {
            return;
        }
        this.state.historyPicker = reduceOpenHistoryPicker(
            this.state.historyPicker,
            this.historyEntriesNewestFirst(),
            currentBuffer,
        );
        this.publish();
    }

    navigateHistoryPicker(direction: 'up' | 'down'): void {
        if (!this.state.historyPicker.open) {
            return;
        }
        const visualDirection = direction === 'up' ? 'down' : 'up';
        const next = reduceHistoryPickerNavigation(
            this.state.historyPicker,
            visualDirection,
            this.state.historyEntries.length,
        );
        if (next === this.state.historyPicker) {
            return;
        }
        this.state.historyPicker = next;
        this.publish();
    }

    confirmHistoryPicker(): string | undefined {
        if (!this.state.historyPicker.open) {
            return undefined;
        }
        const newestFirst = this.historyEntriesNewestFirst();
        if (newestFirst.length === 0) {
            this.state.historyPicker = closeHistoryPicker(this.state.historyPicker);
            this.publish();
            return undefined;
        }
        const selectedIndex = Math.min(Math.max(this.state.historyPicker.selectedIndex, 0), newestFirst.length - 1);
        const selected = newestFirst[selectedIndex];
        this.state.historyPicker = closeHistoryPicker(this.state.historyPicker);
        this.publish();
        return selected?.text;
    }

    cancelHistoryPicker(): void {
        if (!this.state.historyPicker.open) {
            return;
        }
        this.state.historyPicker = closeHistoryPicker(this.state.historyPicker);
        this.publish();
    }

    private appendHistoryEntry(text: string): void {
        if (text.length === 0) {
            return;
        }
        const last = this.state.historyEntries[this.state.historyEntries.length - 1];
        if (last?.text === text) {
            return;
        }
        this.historyEntryCounter += 1;
        const entry: HistoryPickerEntry = {
            id: `hist-${this.historyEntryCounter}`,
            text,
            timestamp: Date.now(),
        };
        const next = [...this.state.historyEntries, entry];
        this.state.historyEntries =
            next.length > MAX_HISTORY_ENTRIES ? next.slice(next.length - MAX_HISTORY_ENTRIES) : next;
        this.state.historyPicker = clampHistoryPickerSelection(
            this.state.historyPicker,
            this.state.historyEntries.length,
        );
    }

    setFileFrecencyKeys(keys: readonly string[]): void {
        this.fileFrecencyKeys = keys;
        this.refreshFileAutocomplete();
        this.publish();
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

    /**
     * Move the question cursor to `index` without resolving (mouse hover).
     * Unlike {@link selectQuestionByClick}, this never submits — it only makes
     * the hovered row the active row. No-op outside a question overlay.
     */
    hoverQuestion(index: number): void {
        if (this.state.overlayMode !== 'question') return;
        const total = this.state.questionMultiple
            ? this.state.questionOptions.length
            : this.state.questionOptions.length + 1;
        if (index < 0 || index >= total) return;
        if (this.state.questionSelectedIndex === index) return;
        this.state.questionSelectedIndex = index;
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
        this.syncMultiTabAnswers();
        this.publish();
    }

    /** Push the current tab's multi-select labels into the answers array so the
     * tab strip's "answered" state and the Confirm review stay live. */
    private syncMultiTabAnswers(): void {
        const idx = this.state.questionTabIndex;
        const tab = this.rawQuestionTabs[idx];
        if (tab === undefined || !tab.multiple) return;
        const labels: string[] = [];
        for (const i of this.state.questionSelectedIndices) {
            const opt = tab.options[i];
            if (opt !== undefined) labels.push(opt.label);
        }
        this.setQuestionAnswers(this.rawQuestionAnswers.map((answers, i) => (i === idx ? labels : answers)));
    }

    /**
     * Single-select resolves immediately with the clicked label;
     * multi-select toggles membership (mirrors Enter vs Space). The trailing
     * custom-answer row enters custom-input mode. In a batch, a single-select
     * pick records the answer and advances to the next tab instead of resolving.
     */
    selectQuestionByClick(index: number): void {
        if (index < 0) return;
        if (index >= this.rawQuestionOptions.length) {
            if (this.state.questionMultiple) return;
            this.state.questionSelectedIndex = index;
            this.state.questionCustomMode = true;
            this.state.questionCustomBuffer = '';
            this.rawQuestionCustomBuffer = '';
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
            this.syncMultiTabAnswers();
            this.publish();
            return;
        }
        const selected = this.rawQuestionOptions[index];
        const label = selected?.label ?? '';
        if (this.state.questionTabs.length > 0) {
            this.pickQuestionAnswer(label);
            return;
        }
        this.resolveQuestion(label);
    }

    /** Submit the typed custom answer. Batch single-select records + advances
     * (or resolves for a lone question); batch multi adds the text; single mode
     * resolves outright. Exits custom-input mode in every case. */
    submitCustomAnswer(text: string): void {
        const rawText = text === this.state.questionCustomBuffer ? this.rawQuestionCustomBuffer : text;
        this.state.questionCustomMode = false;
        this.state.questionCustomBuffer = '';
        this.rawQuestionCustomBuffer = '';
        if (this.state.questionTabs.length === 0) {
            this.resolveQuestion(rawText);
            return;
        }
        if (this.state.questionMultiple) {
            const idx = this.state.questionTabIndex;
            const current = this.rawQuestionAnswers[idx] ?? [];
            if (!current.includes(rawText)) {
                this.setQuestionAnswers(
                    this.rawQuestionAnswers.map((answers, i) => (i === idx ? [...current, rawText] : answers)),
                );
            }
            this.publish();
            return;
        }
        this.pickQuestionAnswer(rawText);
    }

    enterQuestionCustomMode(): void {
        this.state.questionCustomMode = true;
        this.state.questionCustomBuffer = '';
        this.rawQuestionCustomBuffer = '';
        this.publish();
    }

    appendQuestionCustom(text: string): void {
        this.rawQuestionCustomBuffer += text;
        this.state.questionCustomBuffer = sanitizeTerminalDisplayText(this.rawQuestionCustomBuffer);
        this.publish();
    }

    deleteQuestionCustomChar(): void {
        if (this.rawQuestionCustomBuffer.length === 0) return;
        this.rawQuestionCustomBuffer = this.rawQuestionCustomBuffer.slice(0, -1);
        this.state.questionCustomBuffer = sanitizeTerminalDisplayText(this.rawQuestionCustomBuffer);
        this.publish();
    }

    exitQuestionCustomMode(): void {
        this.state.questionCustomMode = false;
        this.state.questionCustomBuffer = '';
        this.rawQuestionCustomBuffer = '';
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

    appendModelPickerSearch(character: string): void {
        this.state.modelPickerKeypress = appendProviderPromptSearch(this.state.modelPickerKeypress, character);
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
        if (this.state.overlayMode !== 'agents-dashboard') return;
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

    showMissionPanel(rows?: readonly MissionPanelRow[]): void {
        const initialRows = rows ?? [];
        this.state.missionPanel = {
            active: true,
            activeTab: 'runs',
            rows: initialRows,
            selectedIndex: 0,
            loadedAt: new Date().toISOString(),
            count: initialRows.length,
        };
        this.state.overlayMode = 'mission-panel';
        this.publish();
    }

    hideMissionPanel(): void {
        this.state.missionPanel = { ...this.state.missionPanel, active: false };
        this.state.overlayMode = 'none';
        this.publish();
    }

    navigateMissionPanel(direction: number, maxCount?: number): void {
        const count = maxCount ?? this.state.missionPanel.rows.length;
        if (count === 0) return;
        const next = this.state.missionPanel.selectedIndex + direction;
        this.state.missionPanel = {
            ...this.state.missionPanel,
            selectedIndex: Math.min(Math.max(next, 0), count - 1),
        };
        this.publish();
    }

    setMissionPanelTab(tab: MissionPanelTab): void {
        if (this.state.missionPanel.activeTab === tab) return;
        const count = this.state.missionPanel.rows.length;
        const safeIndex = count === 0 ? 0 : Math.min(this.state.missionPanel.selectedIndex, count - 1);
        this.state.missionPanel = {
            ...this.state.missionPanel,
            activeTab: tab,
            selectedIndex: safeIndex,
        };
        this.publish();
    }

    reloadMissions(rows: readonly MissionPanelRow[]): void {
        if (this.state.overlayMode !== 'mission-panel') return;
        const selectedId = this.state.missionPanel.rows[this.state.missionPanel.selectedIndex]?.id;
        const newSelectedIndex =
            selectedId !== undefined
                ? Math.max(
                      0,
                      rows.findIndex((r) => r.id === selectedId),
                  )
                : 0;
        this.state.missionPanel = {
            ...this.state.missionPanel,
            rows,
            selectedIndex: newSelectedIndex,
            loadedAt: new Date().toISOString(),
            count: rows.length,
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
            pendingAssignModel: null,
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

    selectModelForAssignment(): void {
        const state = this.buildModelsOverlayState();
        if (state === null) return;
        const next = selectModelForAssignmentReducer(state);
        this.state.modelsOverlay = {
            ...this.state.modelsOverlay,
            pendingAssignModel: next.pendingAssignModel,
            focusedColumn: next.focusedColumn,
        };
        this.publish();
    }

    async confirmRoleAssignment(): Promise<void> {
        const slice = this.state.modelsOverlay;
        if (slice.pendingAssignModel === null) return;
        const roleRow = slice.roleRows[slice.activeRightIndex];
        if (roleRow === undefined) return;
        const pendingModel = slice.pendingAssignModel;
        this.state.modelsOverlay = { ...this.state.modelsOverlay, pendingAssignModel: null };
        this.publish();
        await this.assignModelsOverlayRole(roleRow.role, pendingModel);
    }

    cancelPendingAssignment(): void {
        if (this.state.modelsOverlay.pendingAssignModel === null) return;
        this.state.modelsOverlay = { ...this.state.modelsOverlay, pendingAssignModel: null };
        this.publish();
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
            pendingAssignModel: slice.pendingAssignModel,
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
        this.appendHistoryEntry(value);
        if (this.state.historyPicker.open) {
            this.state.historyPicker = closeHistoryPicker(this.state.historyPicker);
        }
        if (!value.startsWith('/')) {
            this.appendTypedTranscriptPart({
                id: this.nextSubmittedUserPartId(),
                type: 'user',
                text: value,
            });
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

    setDiffViewerCursor(cursor: number): void {
        if (this.state.overlayMode !== 'diff-viewer') return;
        this.state.diffViewerCursor = cursor;
        this.publish();
    }

    hideDiffViewer(): void {
        if (this.state.overlayMode !== 'diff-viewer') return;
        this.state.diffViewerEntries = [];
        this.state.diffViewerCursor = 0;
        this.state.overlayMode = 'none';
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

    private schedulePublish(ms: number): void {
        if (this.scheduledPublishTimeout !== undefined) return;
        this.publishGeneration += 1;
        const generation = this.publishGeneration;
        this.scheduledPublishTimeout = setTimeout(() => {
            if (generation !== this.publishGeneration) return;
            this.scheduledPublishTimeout = undefined;
            this.publishSnapshot();
        }, ms);
    }

    private cancelScheduledPublish(): void {
        const timeout = this.scheduledPublishTimeout;
        if (timeout === undefined) return;
        this.scheduledPublishTimeout = undefined;
        this.publishGeneration += 1;
        clearTimeout(timeout);
    }

    private publish(): void {
        this.cancelScheduledPublish();
        this.publishSnapshot();
    }

    private publishSnapshot(): void {
        this.snapshot = this.buildSnapshot();
        this.notifyListeners();
    }

    private notifyListeners(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    private hasTypedTranscriptParts(): boolean {
        return this.state.transcriptParts.some((part) => part.type !== 'legacy');
    }

    private appendTypedTranscriptPart(part: TranscriptPart): void {
        if (
            !this.hasTypedTranscriptParts() &&
            this.state.transcriptParts.length === 0 &&
            this.state.outputText.length > 0
        ) {
            this.appendLegacyTranscriptPart(this.state.outputText);
        }
        const parts = upsertTranscriptPart(this.state.transcriptParts, part);
        const toolCallId = 'toolCallId' in part ? part.toolCallId : undefined;
        const previewStatus =
            'status' in part && (part.status === 'completed' || part.status === 'failed') ? part.status : undefined;
        this.state.transcriptParts =
            previewStatus === undefined
                ? parts
                : parts
                      .filter((existing) => {
                          // Drop orphaned previews whose occurrence is older than the settlement's
                          // (claimToolTranscriptOccurrence fallback path). Newer-occurrence FIFO
                          // previews must stay pending until their own settlement arrives.
                          if (
                              toolCallId !== undefined &&
                              existing.id !== part.id &&
                              existing.id !== `${part.id}:preview` &&
                              'toolCallId' in existing &&
                              existing.toolCallId === toolCallId &&
                              'status' in existing &&
                              (existing.status === 'pending' ||
                                  existing.status === 'running' ||
                                  existing.status === 'streaming')
                          ) {
                              const existingOccurrence = extractOccurrenceNumber(existing.id);
                              const settlementOccurrence = extractOccurrenceNumber(part.id);
                              if (
                                  existingOccurrence !== undefined &&
                                  settlementOccurrence !== undefined &&
                                  existingOccurrence >= settlementOccurrence
                              ) {
                                  return true;
                              }
                              return false;
                          }
                          return true;
                      })
                      .map((existing) =>
                          existing.id === `${part.id}:preview` && 'status' in existing && existing.status === 'pending'
                              ? { ...existing, status: previewStatus }
                              : existing,
                      );
        if (part.type === 'assistant') {
            this.state.activeAssistantMessageId = attributionKeyForAssistantPart(part);
        }
        this.state.transcriptParts = clampTranscriptParts(this.state.transcriptParts);
    }

    private appendLegacyTranscriptPart(text: string): void {
        if (text.length === 0) return;
        const last = this.state.transcriptParts.at(-1);
        if (last?.type === 'legacy') {
            this.state.transcriptParts = [
                ...this.state.transcriptParts.slice(0, -1),
                { ...last, text: `${last.text}${text}` },
            ];
            return;
        }
        this.state.transcriptParts = clampTranscriptParts([
            ...this.state.transcriptParts,
            { id: this.nextLegacyPartId(), type: 'legacy', text },
        ]);
    }

    private nextLegacyPartId(): string {
        do {
            this.legacyPartCounter += 1;
        } while (this.state.transcriptParts.some((part) => part.id === `legacy-${this.legacyPartCounter}`));
        return `legacy-${this.legacyPartCounter}`;
    }

    private nextSubmittedUserPartId(): string {
        const occupiedIds = new Set(this.state.transcriptParts.map((part) => part.id));
        let occurrence = this.submittedUserPartCounter;
        while (occurrence < Number.MAX_SAFE_INTEGER) {
            occurrence += 1;
            const id = `submitted-user-${occurrence}`;
            if (!occupiedIds.has(id)) {
                this.submittedUserPartCounter = occurrence;
                return id;
            }
        }
        occurrence = 1;
        while (occupiedIds.has(`submitted-user-${occurrence}`)) {
            occurrence += 1;
        }
        this.submittedUserPartCounter = occurrence;
        return `submitted-user-${occurrence}`;
    }

    private buildSnapshot(): ChatStoreState {
        return {
            ...this.state,
            historyPickerView: {
                open: this.state.historyPicker.open,
                selectedIndex: this.state.historyPicker.selectedIndex,
                total: this.state.historyEntries.length,
                draftSnapshot: this.state.historyPicker.draftSnapshot,
            },
        };
    }

    private setQuestionAnswers(answers: readonly (readonly string[])[]): void {
        this.rawQuestionAnswers = answers;
        this.state.questionAnswers = answers.map((labels) => labels.map(sanitizeTerminalDisplayText));
    }

    private rawQuestionAnswerForDisplay(answer: string): string {
        const selectedOptions = this.rawQuestionOptions.filter((_option, index) =>
            this.state.questionSelectedIndices.has(index),
        );
        const displaySelectedAnswer = this.state.questionOptions
            .filter((_option, index) => this.state.questionSelectedIndices.has(index))
            .map((option) => option.label)
            .join(', ');
        if (this.state.questionMultiple && answer === displaySelectedAnswer) {
            return selectedOptions.map((option) => option.label).join(', ');
        }
        const selectedIndex = this.state.questionSelectedIndex;
        const displayOption = this.state.questionOptions[selectedIndex];
        const rawOption = this.rawQuestionOptions[selectedIndex];
        return answer === displayOption?.label ? (rawOption?.label ?? answer) : answer;
    }

    private clearRawQuestionState(): void {
        this.rawQuestionText = '';
        this.rawQuestionHeader = '';
        this.rawQuestionOptions = [];
        this.rawQuestionCustomBuffer = '';
        this.rawQuestionTabs = [];
        this.rawQuestionAnswers = [];
    }

    private refreshFileAutocomplete(): void {
        const prefix = readActiveFilePrefix(this.state.inputMirror);
        if (prefix === undefined) {
            this.state.fileAutocomplete = createFileAutocompleteState();
            return;
        }
        this.state.fileAutocomplete = updateFileAutocomplete(this.state.fileAutocomplete, prefix, this.workspaceRoot, {
            frecencyKeys: this.fileFrecencyKeys,
        });
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

function reverseHistoryEntries(entries: readonly HistoryPickerEntry[]): readonly HistoryPickerEntry[] {
    if (entries.length <= 1) {
        return entries;
    }
    return [...entries].reverse();
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
