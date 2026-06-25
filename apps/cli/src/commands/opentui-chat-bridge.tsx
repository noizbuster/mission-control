/** @jsxImportSource @opentui/react */
/**
 * Bridge between opentui's React component tree and the imperative chat loop.
 *
 * Architecture: `mountOpenTui(<ChatRoot />)` is awaited once inside
 * `createOpenTuiChatBridge`. Inside `ChatRoot`, opentui's `useKeyboard` feeds
 * one `KeyEvent` per physical keypress through `createKeyEventAdapter`, which
 * reproduces Ink's `{ input, key }` assembly so `handleInput` (and its ~30 call
 * sites) work unchanged. `handleInput` mutates the bridge core's input buffer
 * and enqueues `ChatInputEvent`s; the imperative `runInteractiveChatSession`
 * loop `await`s events from `bridge.waitForEvent()`.
 *
 * The bridge core is the single source of truth for mutable state (input buffer,
 * output text, event queue, event waiters, slash command menu state, model picker
 * state). `ChatRoot` subscribes to it via `useSyncExternalStore` purely for
 * rendering, so the keyboard handler always reads fresh state from the core and
 * never closes over a stale React snapshot.
 *
 * `useKeyboard` is resolved dynamically (via `await import('@opentui/react')`)
 * and threaded into `ChatRoot` as a prop, keeping `@opentui/react` out of the
 * eager module graph so non-TUI CLI runs (plain/JSON) never load the renderer.
 *
 * Slash command autocomplete: when the input buffer starts with `/`, a filtered
 * command menu renders above the input. Arrow up/down navigates the selection,
 * and Enter resolves a partial match (e.g. `/ex` -> `/exit`) before submitting.
 *
 * Model picker overlay: when `/model` opens the picker, the bridge core switches
 * into `modelPickerActive` mode. `handleInput` routes all keystrokes to
 * `handleModelPickerInput`, which drives the shared `ProviderPromptKeypress`
 * reducer (the same state machine used by the terminal model selector and auth
 * provider prompts). ChatRoot renders the picker as a full overlay, replacing the
 * normal output/menu/input area until a selection is made or cancelled.
 */

import type { CliRenderer, KeyEvent, PasteEvent, ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AbgOverlay, type AbgOverlayTab } from '../components/AbgOverlay.js';
import { ChatInputTextarea } from '../components/ChatInputTextarea.js';
import { ChatTranscript } from '../components/ChatTranscript.js';
import { getCachedBlocks, Markdown } from '../components/markdown/Markdown.js';
import { darkTheme, type TerminalMarkdownTheme } from '../components/markdown/theme.js';
import { Separator, type SeparatorState } from '../components/Separator.js';
import { StatusBar } from '../components/StatusBar.js';
import { resolveSpinnerMode, useSpinnerFrame } from '../components/spinner.js';
import { ToolCard } from '../components/ToolCard.js';
import { createKeyEventAdapter, type InkKeyShape } from '../platform/key-event-adapter.js';
// Re-exported so bridge tests can import InkKeyShape from the same module they
// import handleInput / createOpenTuiChatBridgeCore from (the Ink Key dependency).
export type { InkKeyShape } from '../platform/key-event-adapter.js';
import { createClipboardService } from '../platform/clipboard-service.js';
import { mountOpenTui } from '../platform/opentui-renderer.js';
import { toOpenTuiColor, toOpenTuiAttributes } from '../platform/opentui-types.js';
import { copy, type Toast } from '../platform/selection-copy.js';

/**
 * opentui `useKeyboard` hook signature. Resolved dynamically inside
 * `createOpenTuiChatBridge` (via `await import('@opentui/react')`) and threaded
 * into `ChatRoot` as a prop so `@opentui/react` stays out of the eager module
 * graph for non-TUI CLI runs.
 */
type UseKeyboardHook = (handler: (key: KeyEvent) => void) => void;

/**
 * opentui `useRenderer` hook signature. Resolved from the same dynamic
 * `@opentui/react` import as `useKeyboard` and threaded into `ChatRoot`, which
 * calls it to obtain the live `CliRenderer` for the OSC52 clipboard service and
 * the copy-on-mouseup selection handler. Threading (rather than a static
 * import) keeps `@opentui/react` out of the eager module graph for non-TUI runs.
 */
type UseRendererHook = () => CliRenderer;
import type { AbgOverlayController } from './abg-overlay-controller.js';
import type { ApprovalLevel } from './approval-level.js';
import {
    createProviderPromptKeypressState,
    createProviderPromptView,
    type ProviderPromptKeypressState,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    createWorkflowCommandMenuView,
    reduceSlashCommandMenuSelection,
    reduceWorkflowCommandMenuSelection,
    resolveSlashCommandMenuSubmission,
    resolveWorkflowCommandMenuInsertText,
    resolveWorkflowCommandMenuSubmission,
    type SlashCommandMenuState,
} from './interactive-chat-command-menu.js';
import {
    buildFileAutocompleteCompletion,
    createFileAutocompleteState,
    createFileAutocompleteView,
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
import type { ModelChoice } from './interactive-chat-model.js';
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Terminal title via OSC 2 (`\x1b]2;<title>\x07`, BEL terminator).
 * Gated on `isTTY` (no escapes to pipes) and `MCTRL_DISABLE_TERMINAL_TITLE !== '1'`.
 */
const TERMINAL_TITLE_ENABLE_ENV = 'MCTRL_ENABLE_TERMINAL_TITLE';
const TERMINAL_TITLE_SET_PREFIX = '\x1b]2;';
const TERMINAL_TITLE_SET_SUFFIX = '\x07';
const TERMINAL_TITLE_RESET = '\x1b]2;\x07';

function shouldManageTerminalTitle(): boolean {
    return process.env[TERMINAL_TITLE_ENABLE_ENV] === '1' && process.stdout.isTTY === true;
}

export function setTerminalTitle(title: string): boolean {
    if (!shouldManageTerminalTitle()) {
        return false;
    }
    process.stderr.write(`${TERMINAL_TITLE_SET_PREFIX}${title}${TERMINAL_TITLE_SET_SUFFIX}`);
    return true;
}

export function resetTerminalTitle(): boolean {
    if (!shouldManageTerminalTitle()) {
        return false;
    }
    process.stderr.write(TERMINAL_TITLE_RESET);
    return true;
}

/**
 * Labeled option for the `ask_user` overlay. `description` renders as dim
 * subtext beneath the label. Mirrors `AskUserOption` without crossing the
 * package boundary for a TUI-only value.
 */
export type QuestionOption = {
    readonly label: string;
    readonly description?: string;
};

/**
 * Normalize legacy `string[]` or labeled `{ label, description? }` options.
 * The conditional `description` spread honors `exactOptionalPropertyTypes`
 * by never emitting an explicit `undefined`.
 */
export function normalizeQuestionOptions(options: readonly (string | QuestionOption)[]): readonly QuestionOption[] {
    return options.map((option) => {
        if (typeof option === 'string') {
            return { label: option };
        }
        return {
            label: option.label,
            ...(option.description !== undefined ? { description: option.description } : {}),
        };
    });
}

type BridgeSnapshot = {
    readonly inputBuffer: string;
    readonly cursorPosition: number;
    readonly outputText: string;
    readonly menuState: SlashCommandMenuState;
    readonly workflowNames: readonly string[];
    readonly fileAutocomplete: FileAutocompleteState;
    readonly modelPickerActive: boolean;
    readonly modelPickerChoices: readonly ModelChoice[];
    readonly modelPickerKeypress: ProviderPromptKeypressState;
    readonly levelPickerActive: boolean;
    readonly levelPickerSelectedIndex: number;
    readonly modelCycleChoices: readonly ModelChoice[];
    readonly modelCycleIndex: number;
    readonly generating: boolean;
    readonly agentStatusText: string;
    readonly approvalActive: boolean;
    readonly approvalToolName: string;
    readonly approvalAction: string;
    readonly approvalSelectedIndex: number;
    readonly questionActive: boolean;
    readonly questionText: string;
    readonly questionHeader: string;
    readonly questionOptions: readonly QuestionOption[];
    readonly questionSelectedIndex: number;
    readonly questionMultiple: boolean;
    readonly questionSelectedIndices: ReadonlySet<number>;
    readonly questionCustomMode: boolean;
    readonly questionCustomBuffer: string;
    readonly showThinking: boolean;
    readonly toolOutputExpanded: boolean;
    readonly renameModeActive: boolean;
    readonly renameBuffer: string;
    readonly historyNavigation: { readonly position: number; readonly total: number } | null;
    readonly abgOverlayActive: boolean;
    readonly abgOverlayActiveTab: number;
    readonly abgOverlayScrollOffset: number;
    readonly abgOverlayLiveOutput: boolean;
    readonly approvalLevel: ApprovalLevel | undefined;
};

/** Public surface consumed by the imperative chat loop. */
export type OpenTuiChatBridge = {
    readonly waitForEvent: () => Promise<ChatInputEvent>;
    readonly emitOutput: (text: string) => void;
    readonly replaceOutputText: (text: string) => void;
    readonly getOutput: () => string;
    readonly showModelPicker: (choices: readonly ModelChoice[]) => Promise<ModelProviderSelection | undefined>;
    readonly showLevelPicker: (currentLevel?: string) => Promise<string | undefined>;
    readonly setApprovalLevel: (level: ApprovalLevel | undefined) => void;
    readonly setModelCycleChoices: (choices: readonly ModelChoice[]) => void;
    onModelCycleSelect: ((selection: ModelProviderSelection) => void) | undefined;
    onRenameSubmit: ((name: string) => void) | undefined;
    readonly setGenerating: (value: boolean) => void;
    readonly setWorkflowNames: (names: readonly string[]) => void;
    readonly setAgentStatus: (text: string) => void;
    readonly clearAgentStatus: () => void;
    readonly isShowThinking: () => boolean;
    readonly isToolOutputExpanded: () => boolean;
    readonly showApproval: (toolName: string, action: string) => void;
    readonly hideApproval: () => void;
    readonly showQuestion: (
        question: string,
        options: readonly (string | QuestionOption)[],
        metadata?: { readonly header?: string; readonly multiple?: boolean },
    ) => Promise<string>;
    readonly applyAbgOverlayPrefs: (prefs: {
        readonly activeTabIndex: number;
        readonly scrollOffset: number;
        readonly liveOutput: boolean;
        readonly showThinking: boolean;
        readonly toolOutputExpanded: boolean;
    }) => void;
    readonly getAbgOverlayPrefsSnapshot: () => {
        readonly activeTabIndex: number;
        readonly scrollOffset: number;
        readonly liveOutput: boolean;
        readonly showThinking: boolean;
        readonly toolOutputExpanded: boolean;
    };
    readonly unmount: () => void;
};

/** Provider/model/session info passed through to the StatusBar render surface. */
export type OpenTuiChatBridgeOptions = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
    readonly workspaceRoot?: string;
    readonly gitBranch?: string;
    readonly initialHistoryEntries?: readonly string[];
    readonly initialApprovalLevel?: ApprovalLevel;
    readonly abgOverlayController?: AbgOverlayController;
};

export type OpenTuiChatBridgeCore = {
    inputBuffer: string;
    cursorPosition: number;
    outputText: string;
    menuState: SlashCommandMenuState;
    workflowNames: readonly string[];
    fileAutocomplete: FileAutocompleteState;
    workspaceRoot: string;
    eventQueue: ChatInputEvent[];
    eventWaiters: Array<(event: ChatInputEvent) => void>;
    listeners: Set<() => void>;
    snapshot: BridgeSnapshot;
    unmountFn: (() => void) | undefined;
    modelPickerChoices: readonly ModelChoice[];
    modelPickerKeypress: ProviderPromptKeypressState;
    modelPickerActive: boolean;
    modelPickerResolve: ((selection: ModelProviderSelection | undefined) => void) | undefined;
    levelPickerActive: boolean;
    levelPickerSelectedIndex: number;
    levelPickerResolve: ((level: string | undefined) => void) | undefined;
    modelCycleChoices: readonly ModelChoice[];
    modelCycleIndex: number;
    onModelCycleSelect: ((selection: ModelProviderSelection) => void) | undefined;
    generating: boolean;
    agentStatusText: string;
    approvalActive: boolean;
    approvalToolName: string;
    approvalAction: string;
    approvalSelectedIndex: number;
    questionActive: boolean;
    questionText: string;
    questionHeader: string;
    questionOptions: readonly QuestionOption[];
    questionSelectedIndex: number;
    questionMultiple: boolean;
    questionSelectedIndices: Set<number>;
    questionCustomMode: boolean;
    questionCustomBuffer: string;
    questionResolve: ((answer: string) => void) | undefined;
    showThinking: boolean;
    toolOutputExpanded: boolean;
    renameModeActive: boolean;
    renameBuffer: string;
    onRenameSubmit: ((name: string) => void) | undefined;
    history: ChatInputHistory;
    lastEscTimestamp: number | undefined;
    submitting: boolean;
    abgOverlayActive: boolean;
    abgOverlayActiveTab: number;
    abgOverlayScrollOffset: number;
    abgOverlayLiveOutput: boolean;
    abgOverlayController: AbgOverlayController | undefined;
    abgOverlayUnsubscribe: (() => void) | undefined;
    abgOverlayRefreshTimer: ReturnType<typeof setInterval> | undefined;
    approvalLevel: ApprovalLevel | undefined;
};

/** Minimal props the React tree uses to talk to the bridge core. */
type ChatRootProps = {
    readonly bridge: {
        readonly subscribe: (listener: () => void) => () => void;
        readonly getSnapshot: () => BridgeSnapshot;
        readonly handleInput: (input: string, key: InkKeyShape) => void;
        readonly handleSubmit: (textareaRef: TextareaRef) => void;
        readonly handleContentChange: (text: string) => void;
        readonly handleTextareaKeyDown: (key: KeyEvent, textareaRef: TextareaRef, scrollboxRef: ScrollboxRef) => void;
        readonly handlePaste: (event: PasteEvent, textareaRef: TextareaRef) => void;
        readonly abgOverlayController?: AbgOverlayController;
    };
    readonly statusBarProps?: OpenTuiChatBridgeOptions;
    readonly useKeyboard: UseKeyboardHook;
    readonly useRenderer: UseRendererHook;
};

const slashMenuMaxVisibleChoices = 5;
const modelPickerMaxVisibleChoices = 10;
const fileAutocompleteMaxVisibleChoices = 8;
const WHITESPACE_PATTERN = /\s/u;
const DOUBLE_ESC_WINDOW_MS = 500;
const DOUBLE_ESC_ACTION_ENV = 'MCTRL_DOUBLE_ESC_ACTION';

export function publishSnapshot(core: OpenTuiChatBridgeCore): void {
    const historyNavigation = isNavigatingChatInputHistory(core.history)
        ? { position: core.history.cursor + 1, total: core.history.entries.length }
        : null;
    core.snapshot = {
        inputBuffer: core.inputBuffer,
        cursorPosition: core.cursorPosition,
        outputText: core.outputText,
        menuState: core.menuState,
        workflowNames: core.workflowNames,
        fileAutocomplete: core.fileAutocomplete,
        modelPickerActive: core.modelPickerActive,
        modelPickerChoices: core.modelPickerChoices,
        modelPickerKeypress: core.modelPickerKeypress,
        levelPickerActive: core.levelPickerActive,
        levelPickerSelectedIndex: core.levelPickerSelectedIndex,
        modelCycleChoices: core.modelCycleChoices,
        modelCycleIndex: core.modelCycleIndex,
        generating: core.generating,
        agentStatusText: core.agentStatusText,
        approvalActive: core.approvalActive,
        approvalToolName: core.approvalToolName,
        approvalAction: core.approvalAction,
        approvalSelectedIndex: core.approvalSelectedIndex,
        questionActive: core.questionActive,
        questionText: core.questionText,
        questionHeader: core.questionHeader,
        questionOptions: core.questionOptions,
        questionSelectedIndex: core.questionSelectedIndex,
        questionMultiple: core.questionMultiple,
        questionSelectedIndices: core.questionSelectedIndices,
        questionCustomMode: core.questionCustomMode,
        questionCustomBuffer: core.questionCustomBuffer,
        showThinking: core.showThinking,
        toolOutputExpanded: core.toolOutputExpanded,
        renameModeActive: core.renameModeActive,
        renameBuffer: core.renameBuffer,
        historyNavigation,
        abgOverlayActive: core.abgOverlayActive,
        abgOverlayActiveTab: core.abgOverlayActiveTab,
        abgOverlayScrollOffset: core.abgOverlayScrollOffset,
        abgOverlayLiveOutput: core.abgOverlayLiveOutput,
        approvalLevel: core.approvalLevel,
    };
    for (const listener of core.listeners) {
        listener();
    }
}

function enqueueEvent(core: OpenTuiChatBridgeCore, event: ChatInputEvent): void {
    const waiter = core.eventWaiters.shift();
    if (waiter !== undefined) {
        waiter(event);
        return;
    }
    core.eventQueue.push(event);
}

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

function refreshFileAutocomplete(core: OpenTuiChatBridgeCore): void {
    const prefix = readActiveFilePrefix(core.inputBuffer);
    if (prefix === undefined) {
        core.fileAutocomplete = createFileAutocompleteState();
        return;
    }
    core.fileAutocomplete = updateFileAutocomplete(core.fileAutocomplete, prefix, core.workspaceRoot);
}

function applyFileAutocompleteCompletion(
    core: OpenTuiChatBridgeCore,
    textareaRef: React.RefObject<TextareaRenderable | null>,
): boolean {
    const completed = buildFileAutocompleteCompletion(core.fileAutocomplete);
    if (completed === undefined) {
        return false;
    }
    const textarea = textareaRef.current;
    if (textarea === null) {
        return false;
    }
    const text = textarea.plainText;
    const atSuffix = `@${core.fileAutocomplete.prefix}`;
    if (!text.endsWith(atSuffix)) {
        return false;
    }
    const before = text.slice(0, text.length - atSuffix.length);
    // The textarea is authoritative: rewrite through it (never core.inputBuffer buffer-end).
    const next = `${before}@${completed}`;
    textarea.setText(next);
    textarea.gotoBufferEnd();
    core.inputBuffer = next;
    return true;
}

/**
 * Build a fresh bridge core with default initial state. Exported so unit tests
 * can drive `handleInput` against the same initial state the runtime uses.
 */
export function createOpenTuiChatBridgeCore(options?: {
    readonly workspaceRoot?: string;
    readonly initialHistoryEntries?: readonly string[];
    readonly initialApprovalLevel?: ApprovalLevel;
}): OpenTuiChatBridgeCore {
    const workspaceRoot = options?.workspaceRoot ?? process.cwd();
    const history =
        options?.initialHistoryEntries !== undefined
            ? createChatInputHistoryFromEntries(options.initialHistoryEntries)
            : createChatInputHistory();
    const initialApprovalLevel = options?.initialApprovalLevel;
    return {
        inputBuffer: '',
        cursorPosition: 0,
        outputText: '',
        menuState: createSlashCommandMenuState(),
        workflowNames: [],
        fileAutocomplete: createFileAutocompleteState(),
        workspaceRoot,
        eventQueue: [],
        eventWaiters: [],
        listeners: new Set(),
        snapshot: {
            inputBuffer: '',
            cursorPosition: 0,
            outputText: '',
            menuState: createSlashCommandMenuState(),
            workflowNames: [],
            fileAutocomplete: createFileAutocompleteState(),
            modelPickerActive: false,
            modelPickerChoices: [],
            modelPickerKeypress: createProviderPromptKeypressState(),
            levelPickerActive: false,
            levelPickerSelectedIndex: 0,
            modelCycleChoices: [],
            modelCycleIndex: 0,
            generating: false,
            agentStatusText: '',
            approvalActive: false,
            approvalToolName: '',
            approvalAction: '',
            approvalSelectedIndex: 0,
            questionActive: false,
            questionText: '',
            questionHeader: '',
            questionOptions: [],
            questionSelectedIndex: 0,
            questionMultiple: false,
            questionSelectedIndices: new Set<number>(),
            questionCustomMode: false,
            questionCustomBuffer: '',
            showThinking: true,
            toolOutputExpanded: false,
            renameModeActive: false,
            renameBuffer: '',
            historyNavigation: null,
            abgOverlayActive: false,
            abgOverlayActiveTab: 0,
            abgOverlayScrollOffset: 0,
            abgOverlayLiveOutput: false,
            approvalLevel: initialApprovalLevel,
        },
        unmountFn: undefined,
        modelPickerChoices: [],
        modelPickerKeypress: createProviderPromptKeypressState(),
        modelPickerActive: false,
        modelPickerResolve: undefined,
        levelPickerActive: false,
        levelPickerSelectedIndex: 0,
        levelPickerResolve: undefined,
        modelCycleChoices: [],
        modelCycleIndex: 0,
        onModelCycleSelect: undefined,
        generating: false,
        agentStatusText: '',
        approvalActive: false,
        approvalToolName: '',
        approvalAction: '',
        approvalSelectedIndex: 0,
        questionActive: false,
        questionText: '',
        questionHeader: '',
        questionOptions: [],
        questionSelectedIndex: 0,
        questionMultiple: false,
        questionSelectedIndices: new Set<number>(),
        questionCustomMode: false,
        questionCustomBuffer: '',
        questionResolve: undefined,
        showThinking: true,
        toolOutputExpanded: false,
        renameModeActive: false,
        renameBuffer: '',
        onRenameSubmit: undefined,
        history,
        lastEscTimestamp: undefined,
        submitting: false,
        abgOverlayActive: false,
        abgOverlayActiveTab: 0,
        abgOverlayScrollOffset: 0,
        abgOverlayLiveOutput: false,
        abgOverlayController: undefined,
        abgOverlayUnsubscribe: undefined,
        abgOverlayRefreshTimer: undefined,
        approvalLevel: initialApprovalLevel,
    };
}

/**
 * Replace `core.outputText` entirely and publish a fresh snapshot. Exported
 * so unit tests can verify display truncation without mounting the Ink tree.
 */
export function replaceCoreOutputText(core: OpenTuiChatBridgeCore, text: string): void {
    core.outputText = text;
    publishSnapshot(core);
}

const SUSPEND_UNSUPPORTED_MESSAGE = 'Suspend not supported on Windows.\n';

/**
 * Suspend signal controls. Exported as an object so unit tests can spy on
 * `isWindowsPlatform` (simulate Windows on a POSIX CI runner) and intercept
 * the real SIGTSTP via `vi.spyOn(process, 'kill')` without actually
 * suspending the test runner.
 */
export const suspendControls = {
    isWindowsPlatform(): boolean {
        return process.platform === 'win32';
    },
    sendSuspendSignal(): void {
        process.kill(process.pid, 'SIGTSTP');
    },
};

const NO_EDITOR_MESSAGE = 'No editor set. Set $VISUAL or $EDITOR.\n';
const VISUAL_ENV = 'VISUAL';
const EDITOR_ENV = 'EDITOR';

/**
 * External editor controls. Exported as an object so unit tests can mock
 * `resolveEditor` (simulate $VISUAL/$EDITOR presence/absence and priority)
 * and `runEditor` (intercept the real `spawnSync` so no editor is launched).
 */
export const editorControls = {
    resolveEditor(): string | undefined {
        return process.env[VISUAL_ENV] ?? process.env[EDITOR_ENV];
    },
    runEditor(editor: string, filePath: string): void {
        spawnSync(editor, [filePath], { stdio: 'inherit' });
    },
};

const LINUX_CLIPBOARD_IMAGE_COMMANDS = ['xclip -selection clipboard -t image/png -o', 'wl-paste -t image/png'] as const;

/**
 * Clipboard image paste controls. Exported so unit tests can spy on
 * `readClipboardImage` (simulate clipboard with image, without image, or
 * tool absence) without launching real platform clipboard binaries.
 *
 * Platform coverage: Linux X11 (xclip), Linux Wayland (wl-paste), macOS
 * (pngpaste). Windows and unknown platforms return undefined. On failure
 * (tool absent, clipboard has no image), returns undefined silently.
 */
export const clipboardImageControls = {
    readClipboardImage(): { readonly path: string } | undefined {
        const tempPath = join(tmpdir(), `mctrl-paste-${Date.now()}.png`);
        if (process.platform === 'linux') {
            return readLinuxClipboardImage(tempPath);
        }
        if (process.platform === 'darwin') {
            return readMacOSClipboardImage(tempPath);
        }
        return undefined;
    },
};

function readLinuxClipboardImage(tempPath: string): { readonly path: string } | undefined {
    for (const command of LINUX_CLIPBOARD_IMAGE_COMMANDS) {
        try {
            const buffer = execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] });
            if (buffer.length === 0) {
                return undefined;
            }
            writeFileSync(tempPath, buffer);
            return { path: tempPath };
        } catch {
            // Command not installed or clipboard has no image — try next tool.
        }
    }
    return undefined;
}

function readMacOSClipboardImage(tempPath: string): { readonly path: string } | undefined {
    try {
        execSync(`pngpaste ${tempPath}`, { stdio: 'ignore' });
        return { path: tempPath };
    } catch {
        return undefined;
    }
}

/**
 * Handle Ctrl+Z: on POSIX, suspend the process via SIGTSTP (the shell's `fg`
 * resumes it with Ink state intact); on Windows, report that suspension is
 * unsupported. Never exits or enqueues a chat event.
 */
export function handleSuspendRequest(core: OpenTuiChatBridgeCore): void {
    if (suspendControls.isWindowsPlatform()) {
        core.outputText += SUSPEND_UNSUPPORTED_MESSAGE;
        publishSnapshot(core);
        return;
    }
    suspendControls.sendSuspendSignal();
}

/**
 * Double-Esc action resolver. The default is `'interrupt'` so a stuck run
 * (one that hangs outside the streaming state, where `generating` is false
 * but `activeTurn` is still alive) can be force-stopped by mashing Esc.
 *
 * This is safe because ESC-sourced interrupts are tagged `source: 'esc'`,
 * and the main chat loop treats them as stop-only: they interrupt the active
 * turn or no-op when idle, but never trigger the "press twice to exit"
 * exit path that Ctrl+C owns. Exit is exclusively Ctrl+C.
 *
 * Opt-in alternatives: `MCTRL_DOUBLE_ESC_ACTION=tree` enqueues `/tree`,
 * `=fork` enqueues `/fork`, `=none` disables double-Esc entirely (single-Esc
 * still interrupts an active run and clears a non-empty input buffer).
 */
function resolveDoubleEscAction(): 'tree' | 'fork' | 'interrupt' | 'none' {
    const action = process.env[DOUBLE_ESC_ACTION_ENV];
    if (action === 'tree') {
        return 'tree';
    }
    if (action === 'fork') {
        return 'fork';
    }
    if (action === 'none') {
        return 'none';
    }
    return 'interrupt';
}

function handleEscKey(core: OpenTuiChatBridgeCore): void {
    // When the agent is actively generating, Esc interrupts the current run
    // immediately (single press). This prevents accidental exits and provides
    // a reliable stop mechanism while work is in progress.
    if (core.generating) {
        core.lastEscTimestamp = undefined;
        enqueueEvent(core, { type: 'interrupt', interruptedPartialInput: false, source: 'esc' });
        publishSnapshot(core);
        return;
    }
    if (core.fileAutocomplete.open) {
        core.fileAutocomplete = createFileAutocompleteState();
        publishSnapshot(core);
        return;
    }
    if (core.inputBuffer.length > 0) {
        core.inputBuffer = '';
        core.cursorPosition = 0;
        core.menuState = createSlashCommandMenuState();
        core.fileAutocomplete = createFileAutocompleteState();
        publishSnapshot(core);
        return;
    }
    const now = Date.now();
    const action = resolveDoubleEscAction();
    if (action === 'none') {
        return;
    }
    if (core.lastEscTimestamp !== undefined && now - core.lastEscTimestamp < DOUBLE_ESC_WINDOW_MS) {
        core.lastEscTimestamp = undefined;
        if (action === 'tree') {
            enqueueEvent(core, { type: 'line', value: '/tree' });
        } else if (action === 'fork') {
            enqueueEvent(core, { type: 'line', value: '/fork' });
        } else {
            // action === 'interrupt': unlike the single-Esc path this fires
            // regardless of `generating`, covering runs stuck outside streaming.
            // Tagged `source: 'esc'` so the main loop treats it as stop-only
            // and never as an exit candidate.
            enqueueEvent(core, { type: 'interrupt', interruptedPartialInput: false, source: 'esc' });
        }
        publishSnapshot(core);
        return;
    }
    core.lastEscTimestamp = now;
    publishSnapshot(core);
}

function handleModelCycle(core: OpenTuiChatBridgeCore, direction: 1 | -1): void {
    const choices = core.modelCycleChoices;
    if (choices.length <= 1) {
        return;
    }
    core.modelCycleIndex = (core.modelCycleIndex + direction + choices.length) % choices.length;
    const choice = choices[core.modelCycleIndex];
    if (choice !== undefined) {
        core.onModelCycleSelect?.(choice.selection);
    }
    publishSnapshot(core);
}

type TextareaRef = React.RefObject<TextareaRenderable | null>;
type ScrollboxRef = React.RefObject<ScrollBoxRenderable | null>;

/**
 * Mirror the textarea's authoritative text into the bridge core and refresh the
 * derived menus. The textarea owns the buffer; this only keeps the mirror (used
 * by slash/workflow menu views and history-bounds reads) in sync.
 *
 * Exported so unit tests can drive the onContentChange entry point directly
 * against a fake `TextareaLike` ref (see opentui-chat-bridge-test-support.ts).
 */
export function bridgeContentChange(core: OpenTuiChatBridgeCore, text: string): void {
    core.inputBuffer = text;
    core.menuState = createSlashCommandMenuState();
    refreshFileAutocomplete(core);
    publishSnapshot(core);
}

/**
 * IME-safe submit. plainText is snapshotted synchronously before the double-defer
 * so a Ctrl+C during the defer window (which clears the textarea) cannot enqueue
 * an empty `{type:'line'}`. A `submitting` guard blocks a fast double-Enter.
 * The `#`-workflow complete-into-buffer case returns WITHOUT enqueuing a line.
 *
 * Exported so unit tests can drive the onSubmit entry point directly against a
 * fake `TextareaLike` ref (see opentui-chat-bridge-test-support.ts).
 */
export function bridgeSubmit(core: OpenTuiChatBridgeCore, textareaRef: TextareaRef): void {
    const captured = textareaRef.current?.plainText ?? '';
    if (core.submitting) {
        return;
    }
    core.submitting = true;
    setTimeout(() => {
        setTimeout(() => {
            try {
                if (captured.trim() === '') {
                    return;
                }
                if (core.fileAutocomplete.open && applyFileAutocompleteCompletion(core, textareaRef)) {
                    refreshFileAutocomplete(core);
                    publishSnapshot(core);
                    return;
                }
                if (captured.startsWith('#')) {
                    const insertText = resolveWorkflowCommandMenuInsertText(captured, core.menuState, core.workflowNames);
                    if (insertText !== undefined) {
                        textareaRef.current?.setText(insertText);
                        textareaRef.current?.gotoBufferEnd();
                        core.inputBuffer = insertText;
                        core.menuState = createSlashCommandMenuState();
                        refreshFileAutocomplete(core);
                        publishSnapshot(core);
                        return;
                    }
                }
                let value = captured;
                if (captured.startsWith('/')) {
                    const resolved = resolveSlashCommandMenuSubmission(captured, core.menuState);
                    if (resolved !== captured) {
                        value = resolved;
                    }
                } else if (captured.startsWith('#')) {
                    const resolved = resolveWorkflowCommandMenuSubmission(captured, core.menuState, core.workflowNames);
                    if (resolved !== captured) {
                        value = resolved;
                    }
                }
                enqueueEvent(core, { type: 'line', value });
                core.history = recordSubmittedPrompt(core.history, value);
                if (!value.startsWith('/')) {
                    core.outputText += `You: ${value}\n`;
                }
                textareaRef.current?.clear();
                core.inputBuffer = '';
                core.menuState = createSlashCommandMenuState();
                core.fileAutocomplete = createFileAutocompleteState();
                publishSnapshot(core);
            } finally {
                core.submitting = false;
            }
        }, 0);
    }, 0);
}

/** Real terminal text paste is handled natively by the textarea; image paste is the Ctrl+V chord below. */
function bridgePaste(_core: OpenTuiChatBridgeCore, _event: PasteEvent, _textareaRef: TextareaRef): void {
}

/**
 * All input-area keys route through here (textarea focused). Each handled chord
 * calls `key.preventDefault()` FIRST so the textarea's native binding is
 * suppressed before the logic runs. Up/Down history recall only preventDefaults
 * at the buffer bounds; otherwise the native cursor move wins.
 *
 * Exported so unit tests can drive the textarea onKeyDown entry point directly
 * against a fake `KeyEvent` plus recording `TextareaLike`/scrollbox refs (see
 * opentui-chat-bridge-test-support.ts).
 */
export function bridgeTextareaKeyDown(
    core: OpenTuiChatBridgeCore,
    key: KeyEvent,
    textareaRef: TextareaRef,
    scrollboxRef: ScrollboxRef,
): void {
    const plainText = (): string => textareaRef.current?.plainText ?? core.inputBuffer;

    // Plain Enter submits via onKeyDown (fires before the textarea keyBinding
    // lookup). Redundant safety net: the keyBindings reorder in
    // ChatInputTextarea already makes return→submit win, but this guarantees a
    // submit even if a future opentui version changes the keyBinding merge.
    if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
        key.preventDefault();
        bridgeSubmit(core, textareaRef);
        return;
    }

    // Tab completes the active file-autocomplete selection (restored from the
    // pre-refactor handleInput; Enter-on-autocomplete also completes via
    // bridgeSubmit).
    if (key.name === 'tab' && core.fileAutocomplete.open) {
        key.preventDefault();
        if (applyFileAutocompleteCompletion(core, textareaRef)) {
            refreshFileAutocomplete(core);
            publishSnapshot(core);
        }
        return;
    }

    // Ctrl+C is handled by the global useKeyboard sink (handleInput), not here,
    // to avoid a double-enqueue race.

    if (key.name === 'escape') {
        key.preventDefault();
        if (core.generating) {
            core.lastEscTimestamp = undefined;
            enqueueEvent(core, { type: 'interrupt', interruptedPartialInput: false, source: 'esc' });
            publishSnapshot(core);
            return;
        }
        if (core.fileAutocomplete.open) {
            core.fileAutocomplete = createFileAutocompleteState();
            publishSnapshot(core);
            return;
        }
        if (plainText().length > 0) {
            textareaRef.current?.clear();
            core.inputBuffer = '';
            core.menuState = createSlashCommandMenuState();
            core.fileAutocomplete = createFileAutocompleteState();
            publishSnapshot(core);
            return;
        }
        handleEscKey(core);
        return;
    }

    if (key.ctrl) {
        if (key.name === 'g') {
            key.preventDefault();
            core.abgOverlayActive = !core.abgOverlayActive;
            publishSnapshot(core);
            return;
        }
        if (key.name === 'z') {
            key.preventDefault();
            handleSuspendRequest(core);
            return;
        }
        if (key.name === 'd') {
            key.preventDefault();
            if (plainText().length === 0) {
                enqueueEvent(core, { type: 'interrupt', interruptedPartialInput: false, source: 'ctrl-c' });
            } else {
                textareaRef.current?.deleteChar();
            }
            return;
        }
        if (key.name === 't') {
            key.preventDefault();
            core.showThinking = !core.showThinking;
            publishSnapshot(core);
            return;
        }
        if (key.name === 'o') {
            key.preventDefault();
            core.toolOutputExpanded = !core.toolOutputExpanded;
            publishSnapshot(core);
            return;
        }
        if (key.name === 'p') {
            key.preventDefault();
            handleModelCycle(core, key.shift ? -1 : 1);
            return;
        }
        if (key.name === 'e') {
            key.preventDefault();
            const editor = editorControls.resolveEditor();
            if (editor === undefined) {
                core.outputText += NO_EDITOR_MESSAGE;
                publishSnapshot(core);
                return;
            }
            const tempPath = join(tmpdir(), `mctrl-edit-${Date.now()}.md`);
            writeFileSync(tempPath, plainText(), 'utf-8');
            try {
                editorControls.runEditor(editor, tempPath);
                const edited = readFileSync(tempPath, 'utf-8');
                textareaRef.current?.setText(edited);
                textareaRef.current?.gotoBufferEnd();
                core.inputBuffer = edited;
                core.menuState = createSlashCommandMenuState();
                refreshFileAutocomplete(core);
                publishSnapshot(core);
            } finally {
                unlinkSync(tempPath);
            }
            return;
        }
        if (key.name === 'r') {
            key.preventDefault();
            core.renameModeActive = true;
            core.renameBuffer = '';
            publishSnapshot(core);
            return;
        }
        if (key.name === 'v') {
            key.preventDefault();
            const result = clipboardImageControls.readClipboardImage();
            if (result === undefined) {
                return;
            }
            textareaRef.current?.insertText(`${result.path} `);
            publishSnapshot(core);
            return;
        }
    }

    if (key.name === 'home') {
        key.preventDefault();
        scrollboxRef.current?.scrollTo(0);
        return;
    }
    if (key.name === 'end') {
        key.preventDefault();
        const scrollHeight = scrollboxRef.current?.scrollHeight ?? 0;
        scrollboxRef.current?.scrollTo(scrollHeight);
        return;
    }
    if (key.name === 'pageup') {
        key.preventDefault();
        const half = Math.floor((process.stdout.rows ?? 24) / 2);
        scrollboxRef.current?.scrollBy(-half);
        return;
    }
    if (key.name === 'pagedown') {
        key.preventDefault();
        const half = Math.floor((process.stdout.rows ?? 24) / 2);
        scrollboxRef.current?.scrollBy(half);
        return;
    }

    if (key.name === 'up' || key.name === 'down') {
        const direction: 'up' | 'down' = key.name;
        const buffer = plainText();
        const cursorOffset = textareaRef.current?.cursorOffset ?? 0;
        const atBound = direction === 'up' ? cursorOffset === 0 : cursorOffset === buffer.length;
        const historyOwnsArrows = isNavigatingChatInputHistory(core.history);
        const slashMenuOpen = buffer.startsWith('/');
        const workflowMenuOpen = buffer.startsWith('#');

        const recallHistory = historyOwnsArrows || (atBound && !slashMenuOpen && !workflowMenuOpen && !core.fileAutocomplete.open);
        if (recallHistory) {
            key.preventDefault();
            const result =
                direction === 'up'
                    ? navigateChatInputHistoryUp(core.history, buffer)
                    : navigateChatInputHistoryDown(core.history, buffer);
            core.history = result.history;
            textareaRef.current?.setText(result.input);
            textareaRef.current?.gotoBufferEnd();
            core.inputBuffer = result.input;
            core.menuState = createSlashCommandMenuState();
            refreshFileAutocomplete(core);
            publishSnapshot(core);
            return;
        }

        if (slashMenuOpen) {
            key.preventDefault();
            core.menuState = reduceSlashCommandMenuSelection(
                core.menuState,
                direction === 'up' ? '\u001b[A' : '\u001b[B',
                buffer,
            );
            publishSnapshot(core);
            return;
        }
        if (workflowMenuOpen) {
            key.preventDefault();
            core.menuState = reduceWorkflowCommandMenuSelection(
                core.menuState,
                direction === 'up' ? '\u001b[A' : '\u001b[B',
                buffer,
                core.workflowNames,
            );
            publishSnapshot(core);
            return;
        }
        if (core.fileAutocomplete.open) {
            key.preventDefault();
            core.fileAutocomplete =
                direction === 'up'
                    ? navigateFileAutocompleteUp(core.fileAutocomplete)
                    : navigateFileAutocompleteDown(core.fileAutocomplete);
            publishSnapshot(core);
            return;
        }
    }
}

export function handleInput(core: OpenTuiChatBridgeCore, input: string, key: InkKeyShape): void {
    if (core.approvalActive) {
        handleApprovalInput(core, input, key);
        return;
    }
    if (core.questionActive) {
        handleQuestionInput(core, input, key);
        return;
    }
    if (core.modelPickerActive) {
        handleModelPickerInput(core, input, key);
        return;
    }
    if (core.levelPickerActive) {
        handleLevelPickerInput(core, input, key);
        return;
    }
    if (core.renameModeActive) {
        handleRenameInput(core, input, key);
        return;
    }
    if (core.abgOverlayActive) {
        handleAbgOverlayInput(core, input, key);
        return;
    }
    // Ctrl+C is routed here unconditionally by ChatRoot's useKeyboard (exit-critical),
    // so the exit contract holds even when the textarea is focused or mid-focus-race.
    if (key.ctrl && input === 'c') {
        enqueueEvent(core, {
            type: 'interrupt',
            interruptedPartialInput: core.inputBuffer.length > 0,
            source: 'ctrl-c',
        });
        return;
    }
    // Editing/chord/scroll/history keys route through handleTextareaKeyDown
    // (the textarea's onKeyDown) while the textarea is focused. This global sink
    // only runs for overlay modes, when the textarea is blurred.
}

const approvalOptions = [
    { key: 'once', label: 'Allow once', description: 'allow this request only' },
    { key: 'session', label: 'Allow session', description: 'allow for this session only' },
    { key: 'always', label: 'Always allow', description: 'allow all future matching requests (persisted)' },
    { key: 'deny', label: 'Deny', description: 'block this request' },
] as const;

function handleApprovalInput(core: OpenTuiChatBridgeCore, input: string, key: InkKeyShape): void {
    if (key.upArrow) {
        core.approvalSelectedIndex = (core.approvalSelectedIndex - 1 + approvalOptions.length) % approvalOptions.length;
        publishSnapshot(core);
        return;
    }
    if (key.downArrow) {
        core.approvalSelectedIndex = (core.approvalSelectedIndex + 1) % approvalOptions.length;
        publishSnapshot(core);
        return;
    }
    if (key.return || input.includes('\r') || input.includes('\n')) {
        const selected = approvalOptions[core.approvalSelectedIndex];
        if (selected !== undefined) {
            core.approvalActive = false;
            publishSnapshot(core);
            enqueueEvent(core, { type: 'line', value: selected.key });
        }
        return;
    }
    if (key.ctrl && input === 'c') {
        core.approvalActive = false;
        core.approvalSelectedIndex = 3;
        publishSnapshot(core);
        enqueueEvent(core, { type: 'line', value: 'deny' });
    }
}

/**
 * Handle keystrokes while the `ask_user` question overlay is active.
 *
 * Single-select mode: Up/Down navigates the provided options plus a trailing
 * "Type custom answer..." entry; Enter selects (or enters custom mode);
 * Ctrl+C/Esc cancels (resolves with an empty answer). The trailing custom
 * entry makes the total entry count `questionOptions.length + 1`.
 *
 * Multi-select mode: Up/Down moves the cursor among the options only (no
 * custom entry); Space toggles membership in `questionSelectedIndices`; Enter
 * submits the selected labels joined by newlines; Ctrl+C/Esc cancels.
 */
function handleQuestionInput(core: OpenTuiChatBridgeCore, input: string, key: InkKeyShape): void {
    const totalEntries = core.questionMultiple ? core.questionOptions.length : core.questionOptions.length + 1;
    if (core.questionCustomMode) {
        if (key.ctrl && input === 'c') {
            resolveQuestion(core, '');
            return;
        }
        if (key.escape) {
            core.questionCustomMode = false;
            core.questionCustomBuffer = '';
            publishSnapshot(core);
            return;
        }
        if (key.return || input.includes('\r') || input.includes('\n')) {
            const textBeforeReturn = input.split(/[\r\n]/)[0] ?? '';
            if (textBeforeReturn.length > 0 && !key.ctrl && !key.meta) {
                core.questionCustomBuffer += textBeforeReturn;
            }
            resolveQuestion(core, core.questionCustomBuffer);
            return;
        }
        if (key.backspace) {
            if (core.questionCustomBuffer.length > 0) {
                core.questionCustomBuffer = core.questionCustomBuffer.slice(0, -1);
                publishSnapshot(core);
            }
            return;
        }
        if (input !== '' && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
            core.questionCustomBuffer += input;
            publishSnapshot(core);
        }
        return;
    }
    if (key.upArrow) {
        core.questionSelectedIndex = (core.questionSelectedIndex - 1 + totalEntries) % totalEntries;
        publishSnapshot(core);
        return;
    }
    if (key.downArrow) {
        core.questionSelectedIndex = (core.questionSelectedIndex + 1) % totalEntries;
        publishSnapshot(core);
        return;
    }
    if (core.questionMultiple) {
        if (input === ' ' && !key.ctrl && !key.meta && !key.return && !key.escape) {
            const index = core.questionSelectedIndex;
            if (index < core.questionOptions.length) {
                const next = new Set(core.questionSelectedIndices);
                if (next.has(index)) {
                    next.delete(index);
                } else {
                    next.add(index);
                }
                core.questionSelectedIndices = next;
                publishSnapshot(core);
            }
            return;
        }
        if (key.return || input.includes('\r') || input.includes('\n')) {
            resolveQuestion(core, collectMultiSelectAnswer(core));
            return;
        }
        if ((key.ctrl && input === 'c') || key.escape) {
            resolveQuestion(core, '');
        }
        return;
    }
    if (key.return || input.includes('\r') || input.includes('\n')) {
        if (core.questionSelectedIndex >= core.questionOptions.length) {
            core.questionCustomMode = true;
            core.questionCustomBuffer = '';
            publishSnapshot(core);
            return;
        }
        const selected = core.questionOptions[core.questionSelectedIndex];
        resolveQuestion(core, selected?.label ?? '');
        return;
    }
    if ((key.ctrl && input === 'c') || key.escape) {
        resolveQuestion(core, '');
    }
}

function collectMultiSelectAnswer(core: OpenTuiChatBridgeCore): string {
    const labels: string[] = [];
    for (let index = 0; index < core.questionOptions.length; index++) {
        if (core.questionSelectedIndices.has(index)) {
            const option = core.questionOptions[index];
            if (option !== undefined) {
                labels.push(option.label);
            }
        }
    }
    return labels.join('\n');
}

function resolveQuestion(core: OpenTuiChatBridgeCore, answer: string): void {
    core.questionActive = false;
    core.questionCustomMode = false;
    core.questionCustomBuffer = '';
    core.questionMultiple = false;
    core.questionSelectedIndices = new Set<number>();
    core.questionHeader = '';
    const resolve = core.questionResolve;
    core.questionResolve = undefined;
    publishSnapshot(core);
    resolve?.(answer);
}

function handleRenameInput(core: OpenTuiChatBridgeCore, input: string, key: InkKeyShape): void {
    if (key.return || input.includes('\r') || input.includes('\n')) {
        const textBeforeReturn = input.split(/[\r\n]/)[0] ?? '';
        if (textBeforeReturn.length > 0 && !key.ctrl && !key.meta) {
            core.renameBuffer += textBeforeReturn;
        }
        const name = core.renameBuffer;
        core.renameModeActive = false;
        core.renameBuffer = '';
        publishSnapshot(core);
        if (name.length > 0) {
            core.onRenameSubmit?.(name);
        }
        return;
    }
    if ((key.ctrl && input === 'c') || key.escape) {
        core.renameModeActive = false;
        core.renameBuffer = '';
        publishSnapshot(core);
        return;
    }
    if (key.backspace) {
        if (core.renameBuffer.length > 0) {
            core.renameBuffer = core.renameBuffer.slice(0, -1);
            publishSnapshot(core);
        }
        return;
    }
    if (input !== '' && !key.ctrl && !key.meta) {
        core.renameBuffer += input;
        publishSnapshot(core);
    }
}

function handleModelPickerInput(core: OpenTuiChatBridgeCore, input: string, key: InkKeyShape): void {
    if (key.ctrl && input === 'c') {
        core.modelPickerActive = false;
        core.modelPickerResolve?.(undefined);
        core.modelPickerResolve = undefined;
        publishSnapshot(core);
        return;
    }
    if (key.return || input.includes('\r') || input.includes('\n')) {
        const promptChoices = core.modelPickerChoices.map((choice) => ({
            id: choice.id,
            name: choice.label,
        }));
        const view = createProviderPromptView(core.modelPickerKeypress, promptChoices, modelPickerMaxVisibleChoices);
        const selected = core.modelPickerChoices.find(
            (choice) => choice.id === view.filteredChoices[view.selectedIndex]?.id,
        );
        core.modelPickerActive = false;
        core.modelPickerResolve?.(selected?.selection);
        core.modelPickerResolve = undefined;
        publishSnapshot(core);
        return;
    }
    let rawInput = input;
    if (key.upArrow) {
        rawInput = '\u001b[A';
    } else if (key.downArrow) {
        rawInput = '\u001b[B';
    }
    const promptChoices = core.modelPickerChoices.map((choice) => ({
        id: choice.id,
        name: choice.label,
    }));
    core.modelPickerKeypress = reduceProviderPromptKeypress(core.modelPickerKeypress, rawInput, promptChoices);
    publishSnapshot(core);
}

const APPROVAL_LEVEL_PICKER_COUNT = 5;

function handleLevelPickerInput(core: OpenTuiChatBridgeCore, input: string, key: InkKeyShape): void {
    if (key.ctrl && input === 'c') {
        core.levelPickerActive = false;
        core.levelPickerResolve?.(undefined);
        core.levelPickerResolve = undefined;
        publishSnapshot(core);
        return;
    }
    if (key.upArrow) {
        core.levelPickerSelectedIndex =
            (core.levelPickerSelectedIndex - 1 + APPROVAL_LEVEL_PICKER_COUNT) % APPROVAL_LEVEL_PICKER_COUNT;
        publishSnapshot(core);
        return;
    }
    if (key.downArrow) {
        core.levelPickerSelectedIndex = (core.levelPickerSelectedIndex + 1) % APPROVAL_LEVEL_PICKER_COUNT;
        publishSnapshot(core);
        return;
    }
    if (key.return || input.includes('\r') || input.includes('\n')) {
        const levels = ['verbose', 'safe', 'aggressive', 'reckless', 'yolo'] as const;
        const selected = levels[core.levelPickerSelectedIndex];
        core.levelPickerActive = false;
        core.levelPickerResolve?.(selected);
        core.levelPickerResolve = undefined;
        publishSnapshot(core);
        return;
    }
}

const ABG_OVERLAY_TAB_COUNT = 8;

/**
 * NEVER calls enqueueEvent while active: the chat loop must stay paused (Metis). Unrecognized
 * input falls through to `default: return` and is silently swallowed.
 */
function handleAbgOverlayInput(core: OpenTuiChatBridgeCore, input: string, key: InkKeyShape): void {
    const controller = core.abgOverlayController;

    if ((key.ctrl && input === 'g') || key.escape || input === '\u001b') {
        core.abgOverlayActive = false;
        publishSnapshot(core);
        return;
    }

    if (key.tab) {
        const direction: 1 | -1 = key.shift ? -1 : 1;
        core.abgOverlayActiveTab =
            (core.abgOverlayActiveTab + direction + ABG_OVERLAY_TAB_COUNT) % ABG_OVERLAY_TAB_COUNT;
        publishSnapshot(core);
        return;
    }

    if (key.upArrow) {
        core.abgOverlayScrollOffset += 1;
        publishSnapshot(core);
        return;
    }
    if (key.downArrow) {
        core.abgOverlayScrollOffset = Math.max(0, core.abgOverlayScrollOffset - 1);
        publishSnapshot(core);
        return;
    }
    if (key.pageUp) {
        core.abgOverlayScrollOffset += 10;
        publishSnapshot(core);
        return;
    }
    if (key.pageDown) {
        core.abgOverlayScrollOffset = Math.max(0, core.abgOverlayScrollOffset - 10);
        publishSnapshot(core);
        return;
    }
    if (key.home) {
        core.abgOverlayScrollOffset = Number.MAX_SAFE_INTEGER;
        publishSnapshot(core);
        return;
    }
    if (key.end) {
        core.abgOverlayScrollOffset = 0;
        publishSnapshot(core);
        return;
    }

    if (!key.ctrl && !key.meta) {
        const selectTab = (index: number): void => {
            core.abgOverlayActiveTab = index;
            core.abgOverlayScrollOffset = 0;
            publishSnapshot(core);
        };
        switch (input) {
            case '1':
                selectTab(0);
                return;
            case '2':
                selectTab(1);
                return;
            case '3':
                selectTab(2);
                return;
            case '4':
                selectTab(3);
                return;
            case '5':
                selectTab(4);
                return;
            case '6':
                selectTab(5);
                return;
            case '7':
                selectTab(6);
                return;
            case '8':
                selectTab(7);
                return;
            case 'r':
                controller?.flushNow();
                publishSnapshot(core);
                return;
            case 't':
                core.abgOverlayLiveOutput = !core.abgOverlayLiveOutput;
                publishSnapshot(core);
                return;
            case 'c':
                controller?.clearTimeline();
                publishSnapshot(core);
                return;
            case 'g': {
                const store = controller?.store;
                if (store !== undefined) {
                    const snapshot = store.getSnapshot();
                    const graphIds = [...snapshot.graphs.keys()];
                    if (graphIds.length > 1) {
                        const currentIdx = graphIds.indexOf(snapshot.focusedGraphId ?? '');
                        const nextIdx = (currentIdx + 1) % graphIds.length;
                        const nextGraphId = graphIds[nextIdx];
                        if (nextGraphId !== undefined) {
                            store.update((draft) => {
                                draft.focusedGraphId = nextGraphId;
                            });
                        }
                    }
                }
                publishSnapshot(core);
                return;
            }
            default:
                return;
        }
    }
}

function AgentSpinner({ text }: { readonly text: string }): React.ReactNode {
    const { glyph } = useSpinnerFrame();
    return (
        <box marginTop={1}>
            <text fg="#ffff00">{glyph} </text>
            <text {...toOpenTuiAttributes({ dimColor: true })}>{text}</text>
        </box>
    );
}

const clipboardToast: Toast = {
    show(message: string): void {
        process.stderr.write(`${message}\n`);
    },
    error(err: unknown): void {
        process.stderr.write(`clipboard error: ${String(err)}\n`);
    },
};

function ChatRoot({ bridge, statusBarProps, useKeyboard, useRenderer }: ChatRootProps): React.ReactNode {
    const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
    const keyAdapter = useMemo(() => createKeyEventAdapter(), []);
    const textareaRef = useRef<TextareaRenderable>(null);
    const scrollboxRef = useRef<ScrollBoxRenderable>(null);

    const renderer = useRenderer();
    const clipboardService = useMemo(() => createClipboardService(renderer), [renderer]);
    const handleMouseUp = (): void => {
        // OSC52 is emitted by opentui's native core; tmux needs
        // `set -g set-allow-passthrough on`. Surface the unsupported case over
        // stderr instead of silently no-op'ing when the user had a selection.
        if (!clipboardService.isOsc52Supported()) {
            const selectedText = renderer.getSelection()?.getSelectedText() ?? '';
            if (selectedText.length > 0) {
                process.stderr.write('clipboard copy not supported in this terminal; OSC52 unavailable\n');
            }
            return;
        }
        copy(renderer, clipboardToast, clipboardService);
    };

    const anyOverlayActive =
        snapshot.modelPickerActive ||
        snapshot.levelPickerActive ||
        snapshot.approvalActive ||
        snapshot.questionActive ||
        snapshot.abgOverlayActive ||
        snapshot.renameModeActive;

    useKeyboard((key) => {
        // Ctrl+C is exit-critical: always route through the global sink so the
        // "press twice to exit" contract holds even during the textarea's
        // startup focus race. Other keys early-return when the textarea owns them.
        const isCtrlC = key.ctrl && key.name === 'c';
        if (textareaRef.current?.focused && !isCtrlC) {
            return;
        }
        const adapted = keyAdapter.consume(key);
        bridge.handleInput(adapted.input, adapted.key);
    });

    const handleSubmit = (): void => bridge.handleSubmit(textareaRef);
    const handleContentChange = (text: string): void => bridge.handleContentChange(text);
    const handleTextareaKeyDown = (key: KeyEvent): void => bridge.handleTextareaKeyDown(key, textareaRef, scrollboxRef);
    const handlePaste = (event: PasteEvent): void => bridge.handlePaste(event, textareaRef);

    const messageBlocks = parseMessageBlocks(snapshot.outputText);

    if (snapshot.approvalActive) {
        return (
            <box flexDirection="column">
                <MessageWindow
                    blocks={messageBlocks}
                    scrollboxRef={scrollboxRef}
                    generating={snapshot.generating}
                    toolOutputExpanded={snapshot.toolOutputExpanded}
                />
                <Separator state="awaiting_input" />
                <box flexDirection="column" marginTop={1} paddingX={1}>
                    <text fg="#ffff00" {...toOpenTuiAttributes({ bold: true, inverse: true })}>
                        {' Approval Required '}
                    </text>
                    <box flexDirection="row">
                        <text {...toOpenTuiAttributes({ bold: true })}>Tool:</text>
                        <text> {snapshot.approvalToolName}</text>
                    </box>
                    <text {...toOpenTuiAttributes({ dimColor: true })}>{snapshot.approvalAction}</text>
                    <box flexDirection="column" marginTop={1}>
                        {approvalOptions.map((option, index) => {
                            const isSelected = index === snapshot.approvalSelectedIndex;
                            const selectedBg = isSelected ? { bg: '#0000ff' } : {};
                            return (
                                <box key={option.key} flexDirection="row">
                                    <text {...selectedBg}>
                                        {isSelected ? '> ' : '  '}
                                        {option.label}  </text>
                                    <text {...toOpenTuiAttributes({ dimColor: true })} {...selectedBg}>
                                        {option.description}
                                    </text>
                                </box>
                            );
                        })}
                    </box>
                    <box marginTop={1}>
                        <text {...toOpenTuiAttributes({ dimColor: true })}>
                            Up/Down to navigate, Enter to select, Ctrl+C to deny
                        </text>
                    </box>
                </box>
            </box>
        );
    }

    if (snapshot.questionActive) {
        return (
            <box flexDirection="column">
                <MessageWindow
                    blocks={messageBlocks}
                    scrollboxRef={scrollboxRef}
                    generating={snapshot.generating}
                    toolOutputExpanded={snapshot.toolOutputExpanded}
                />
                <Separator state="awaiting_input" />
                <box flexDirection="column" marginTop={1} paddingX={1}>
                    <text fg="#ff00ff" {...toOpenTuiAttributes({ bold: true, inverse: true })}>
                        {' Question '}
                    </text>
                    {snapshot.questionHeader.length > 0 ? (
                        <text {...toOpenTuiAttributes({ bold: true })}>{snapshot.questionHeader}</text>
                    ) : null}
                    <text>{snapshot.questionText}</text>
                    {snapshot.questionCustomMode ? (
                        <>
                            <box marginTop={1}>
                                <box flexDirection="row">
                                    <text fg="#ff00ff">{'>'}</text>
                                    <text> {snapshot.questionCustomBuffer}</text>
                                    <text bg="#ffffff" fg="#000000">
                                        {'\u2588'}
                                    </text>
                                </box>
                            </box>
                            <text {...toOpenTuiAttributes({ dimColor: true })}>
                                Enter to submit, Esc to go back to options, Ctrl+C to cancel
                            </text>
                        </>
                    ) : (
                        <>
                            <box flexDirection="column" marginTop={1}>
                                {snapshot.questionOptions.map((option, index) => {
                                    const isCursor = index === snapshot.questionSelectedIndex;
                                    const prefix = snapshot.questionMultiple
                                        ? `${snapshot.questionSelectedIndices.has(index) ? '[x] ' : '[ ] '}`
                                        : '';
                                    return (
                                        // biome-ignore lint/suspicious/noArrayIndexKey: question options are positional within a single overlay render
                                        <box key={`q-opt-${index}-${option.label}`} flexDirection="column">
                                            <text {...(isCursor ? { bg: '#0000ff' } : {})}>
                                                {isCursor ? '> ' : '  '}
                                                {prefix}
                                                {option.label}
                                            </text>
                                            {option.description !== undefined ? (
                                                <text {...toOpenTuiAttributes({ dimColor: true })}>
                                                    {`    ${option.description}`}
                                                </text>
                                            ) : null}
                                        </box>
                                    );
                                })}
                                {snapshot.questionMultiple
                                    ? null
                                    : (() => {
                                          const customIndex = snapshot.questionOptions.length;
                                          const isSelected = customIndex === snapshot.questionSelectedIndex;
                                          return (
                                              <box flexDirection="row">
                                                  <text {...(isSelected ? { bg: '#0000ff' } : {})}>
                                                      {isSelected ? '> ' : '  '}
                                                  </text>
                                                  <text
                                                      {...toOpenTuiAttributes({ dimColor: true })}
                                                      {...(isSelected ? { bg: '#0000ff' } : {})}
                                                  >
                                                      Type custom answer...
                                                  </text>
                                              </box>
                                          );
                                      })()}
                            </box>
                            <text {...toOpenTuiAttributes({ dimColor: true })}>
                                {snapshot.questionMultiple
                                    ? 'Up/Down to navigate, Space to toggle, Enter to submit, Esc to cancel'
                                    : 'Up/Down to navigate, Enter to select, Esc to cancel'}
                            </text>
                        </>
                    )}
                </box>
            </box>
        );
    }

    if (snapshot.renameModeActive) {
        return (
            <box flexDirection="column">
                <MessageWindow
                    blocks={messageBlocks}
                    scrollboxRef={scrollboxRef}
                    generating={snapshot.generating}
                    toolOutputExpanded={snapshot.toolOutputExpanded}
                />
                <box flexDirection="column" marginTop={1} paddingX={1}>
                    <text fg="#00ffff" {...toOpenTuiAttributes({ bold: true, inverse: true })}>
                        {' Rename Session '}
                    </text>
                    <text>Enter new session name:</text>
                    <box flexDirection="row">
                        <text fg="#00ffff">{'>'}</text>
                        <text> {snapshot.renameBuffer}</text>
                        <text bg="#ffffff" fg="#000000">
                            {'\u2588'}
                        </text>
                    </box>
                    <text {...toOpenTuiAttributes({ dimColor: true })}>Enter to confirm, Esc to cancel</text>
                </box>
            </box>
        );
    }

    if (snapshot.levelPickerActive) {
        const levels: ReadonlyArray<{ readonly id: string; readonly label: string; readonly desc: string }> = [
            { id: 'verbose', label: 'verbose', desc: 'Ask for every tool call, including reads' },
            { id: 'safe', label: 'safe', desc: 'Auto-approve reads and webfetch; ask before modifications' },
            {
                id: 'aggressive',
                label: 'aggressive',
                desc: 'Auto-approve reads, edits, webfetch, subagent; ask before bash',
            },
            { id: 'reckless', label: 'reckless', desc: 'Auto-approve everything; only bash asks before execution' },
            { id: 'yolo', label: 'yolo', desc: 'Auto-approve everything including subagent (use with caution)' },
        ];
        return (
            <box flexDirection="column">
                <MessageWindow
                    blocks={messageBlocks}
                    scrollboxRef={scrollboxRef}
                    generating={snapshot.generating}
                    toolOutputExpanded={snapshot.toolOutputExpanded}
                />
                <box flexDirection="column" marginTop={1} paddingX={1}>
                    <text fg="#00ffff" {...toOpenTuiAttributes({ bold: true, inverse: true })}>
                        {' Select approval level '}
                    </text>
                    {levels.map((level, index) => {
                        const isSelected = index === snapshot.levelPickerSelectedIndex;
                        return (
                            <box key={level.id} flexDirection="row">
                                <text {...(isSelected ? { bg: '#0000ff' } : {})}>
                                    {isSelected ? '> ' : '  '}
                                    {level.label.padEnd(13)}
                                </text>
                                <text {...toOpenTuiAttributes({ dimColor: true })}>{level.desc}</text>
                            </box>
                        );
                    })}
                    <text {...toOpenTuiAttributes({ dimColor: true })}>
                        {'Up/Down to navigate, Enter to select, Ctrl+C to cancel'}
                    </text>
                </box>
            </box>
        );
    }

    if (snapshot.modelPickerActive) {
        const promptChoices = snapshot.modelPickerChoices.map((choice) => ({
            id: choice.id,
            name: choice.label,
        }));
        const view = createProviderPromptView(
            snapshot.modelPickerKeypress,
            promptChoices,
            modelPickerMaxVisibleChoices,
        );
        return (
            <box flexDirection="column">
                <text fg="#00ffff" {...toOpenTuiAttributes({ bold: true })}>
                    Select model
                </text>
                <text {...toOpenTuiAttributes({ dimColor: true })}>{`Search: ${view.searchQuery}`}</text>
                {view.totalCount === 0 ? (
                    <text {...toOpenTuiAttributes({ dimColor: true })}>No models match</text>
                ) : (
                    <text {...toOpenTuiAttributes({ dimColor: true })}>
                        {`Showing ${view.startIndex + 1}-${view.endIndex} of ${view.totalCount}`}
                    </text>
                )}
                {view.visibleChoices.map((choice, index) => {
                    const globalIndex = view.startIndex + index;
                    const isSelected = globalIndex === view.selectedIndex;
                    return (
                        <text key={choice.id} {...(isSelected ? { bg: '#0000ff' } : {})}>
                            {isSelected ? '> ' : '  '}
                            {globalIndex + 1}. {choice.name}
                        </text>
                    );
                })}
                <text {...toOpenTuiAttributes({ dimColor: true })}>
                    Use Up/Down, type to search, Enter to select, Ctrl+C to cancel
                </text>
            </box>
        );
    }

    if (snapshot.abgOverlayActive) {
        const ABG_OVERLAY_TABS: readonly AbgOverlayTab[] = [
            'overview',
            'graph',
            'nodes',
            'tools',
            'timeline',
            'approvals',
            'cost-policy',
            'blackboard',
        ];
        const activeTab = ABG_OVERLAY_TABS[snapshot.abgOverlayActiveTab] ?? 'overview';
        const store = bridge.abgOverlayController?.store;
        if (store === undefined) {
            return (
                <box flexDirection="column">
                    <text fg="#ff0000">ABG overlay active but store not initialized</text>
                </box>
            );
        }
        return (
            <AbgOverlay
                store={store}
                activeTab={activeTab}
                scrollOffset={snapshot.abgOverlayScrollOffset}
                modelLabel={`${statusBarProps?.providerID ?? 'unknown'}/${statusBarProps?.modelID ?? 'unknown'}`}
            />
        );
    }

    const showSlashMenu = snapshot.inputBuffer.startsWith('/');
    const showWorkflowMenu = snapshot.inputBuffer.startsWith('#');
    const menuView = showSlashMenu
        ? createSlashCommandMenuView(snapshot.inputBuffer, snapshot.menuState, slashMenuMaxVisibleChoices)
        : showWorkflowMenu
          ? createWorkflowCommandMenuView(
                snapshot.inputBuffer,
                snapshot.menuState,
                slashMenuMaxVisibleChoices,
                snapshot.workflowNames,
            )
          : null;
    const fileView =
        !showSlashMenu && !showWorkflowMenu && snapshot.fileAutocomplete.open
            ? createFileAutocompleteView(snapshot.fileAutocomplete, fileAutocompleteMaxVisibleChoices)
            : null;

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: terminal UI; the root box is the mouse-drag selection surface and has no DOM a11y role
        <box flexDirection="column" onMouseUp={handleMouseUp}>
            <Banner {...(statusBarProps !== undefined ? { statusBarProps } : {})} />
            <MessageWindow
                blocks={messageBlocks}
                scrollboxRef={scrollboxRef}
                generating={snapshot.generating}
                toolOutputExpanded={snapshot.toolOutputExpanded}
            />
            {snapshot.agentStatusText.length > 0 ? (
                <AgentSpinner text={snapshot.agentStatusText} />
            ) : snapshot.generating ? (
                <box marginTop={1}>
                    <text fg="#ffff00">{'\u25CF Thinking...'}</text>
                </box>
            ) : null}
            {menuView !== null && menuView.open ? (
                <box flexDirection="column" marginTop={1}>
                    {menuView.empty ? (
                        <text {...toOpenTuiAttributes({ dimColor: true })}> no commands match</text>
                    ) : (
                        menuView.visibleChoices.map((choice, index) => {
                            const globalIndex = menuView.startIndex + index;
                            const isSelected = globalIndex === menuView.selectedIndex;
                            return (
                                <text key={choice.id} {...(isSelected ? { bg: '#0000ff' } : {})}>
                                    {isSelected ? '> ' : '  '}
                                    {choice.id.padEnd(13)} {choice.description}
                                </text>
                            );
                        })
                    )}
                </box>
            ) : null}
            {fileView?.open ? (
                <box flexDirection="column" marginTop={1}>
                    <text {...toOpenTuiAttributes({ dimColor: true })}>{`Files matching @${fileView.prefix}`}</text>
                    {fileView.empty ? (
                        <text {...toOpenTuiAttributes({ dimColor: true })}> no files match</text>
                    ) : (
                        fileView.visibleMatches.map((match, index) => {
                            const globalIndex = fileView.startIndex + index;
                            const isSelected = globalIndex === fileView.selectedIndex;
                            const marker = match.isDirectory ? '/' : ' ';
                            return (
                                <text key={match.name} {...(isSelected ? { bg: '#0000ff' } : {})}>
                                    {isSelected ? '> ' : '  '}
                                    {marker}
                                    {match.name}
                                </text>
                            );
                        })
                    )}
                    <text {...toOpenTuiAttributes({ dimColor: true })}>
                        Tab/Enter to complete, Up/Down to navigate, Esc to close
                    </text>
                </box>
            ) : null}
            <box flexDirection="column" marginTop={1}>
                <Separator state={resolveSeparatorState(snapshot)} />
                <ChatInputTextarea
                    textareaRef={textareaRef}
                    focused={!anyOverlayActive}
                    onSubmit={handleSubmit}
                    onContentChange={handleContentChange}
                    onCursorChange={() => {}}
                    onKeyDown={handleTextareaKeyDown}
                    onPaste={handlePaste}
                    placeholder={
                        snapshot.generating
                            ? 'Press Esc to stop, or wait for the response…'
                            : 'Type a message, / for commands, # for workflows, or Ctrl+C twice to exit'
                    }
                />
            </box>
            {statusBarProps !== undefined ? (
                <box marginTop={1}>
                    <StatusBar
                        {...statusBarProps}
                        {...(snapshot.approvalLevel !== undefined ? { approvalLevel: snapshot.approvalLevel } : {})}
                    />
                </box>
            ) : null}
        </box>
    );
}

/**
 * Mount the Ink tree once and return the imperative bridge. Callers `await`
 * `waitForEvent()` to consume `{ type: 'line' }` / `{ type: 'interrupt' }`
 * events, `emitOutput()` to append chat output, `showModelPicker()` to open the
 * `/model` selection overlay, and `unmount()` to tear down.
 */
/**
 * Detect the current git branch of `workspaceRoot` synchronously via `git rev-parse`.
 * Returns undefined when git is unavailable, the workspace is not a git repo,
 * or `HEAD` is detached (the rev-parse returns `HEAD` literally in that case).
 * Exported for unit tests; never throws.
 */
export function detectGitBranch(workspaceRoot: string | undefined): string | undefined {
    if (workspaceRoot === undefined) {
        return undefined;
    }
    try {
        const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1000,
        });
        if (result.error !== undefined || result.status !== 0) {
            return undefined;
        }
        const branch = (result.stdout ?? '').trim();
        if (branch.length === 0 || branch === 'HEAD') {
            return undefined;
        }
        return branch;
    } catch {
        return undefined;
    }
}

export async function createOpenTuiChatBridge(options?: OpenTuiChatBridgeOptions): Promise<OpenTuiChatBridge> {
    const core = createOpenTuiChatBridgeCore({
        ...(options?.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options?.initialHistoryEntries !== undefined
            ? { initialHistoryEntries: options.initialHistoryEntries }
            : {}),
        ...(options?.initialApprovalLevel !== undefined ? { initialApprovalLevel: options.initialApprovalLevel } : {}),
    });
    if (options?.abgOverlayController !== undefined) {
        core.abgOverlayController = options.abgOverlayController;
        core.abgOverlayUnsubscribe = options.abgOverlayController.store.subscribe(() => {
            publishSnapshot(core);
        });
        core.abgOverlayRefreshTimer = setInterval(() => {
            if (core.abgOverlayActive) {
                publishSnapshot(core);
            }
        }, 100);
    }

    const subscribe = (listener: () => void): (() => void) => {
        core.listeners.add(listener);
        return () => {
            core.listeners.delete(listener);
        };
    };

    const getSnapshot = (): BridgeSnapshot => core.snapshot;

    const internalBridge: ChatRootProps['bridge'] = {
        subscribe,
        getSnapshot,
        handleInput: (input, key) => handleInput(core, input, key),
        handleSubmit: (textareaRef) => bridgeSubmit(core, textareaRef),
        handleContentChange: (text) => bridgeContentChange(core, text),
        handleTextareaKeyDown: (key, textareaRef, scrollboxRef) =>
            bridgeTextareaKeyDown(core, key, textareaRef, scrollboxRef),
        handlePaste: (event, textareaRef) => bridgePaste(core, event, textareaRef),
        ...(core.abgOverlayController !== undefined ? { abgOverlayController: core.abgOverlayController } : {}),
    };

    const statusBarProps: OpenTuiChatBridgeOptions | undefined =
        options !== undefined
            ? {
                  ...options,
                  ...(options.gitBranch === undefined && options.workspaceRoot !== undefined
                      ? (() => {
                            const detected = detectGitBranch(options.workspaceRoot);
                            return detected !== undefined ? { gitBranch: detected } : {};
                        })()
                      : {}),
              }
            : undefined;

    // Dynamic import keeps @opentui/react out of the eager module graph so
    // non-TUI CLI runs (plain/JSON) never load the renderer. Resolved here
    // (right before mounting) and threaded into ChatRoot via props.
    const { useKeyboard, useRenderer } = await import('@opentui/react');
    const mountResult = await mountOpenTui(
        <ChatRoot
            bridge={internalBridge}
            useKeyboard={useKeyboard}
            useRenderer={useRenderer}
            {...(statusBarProps !== undefined ? { statusBarProps } : {})}
        />,
    );
    core.unmountFn = mountResult.unmount;
    const titleWasSet = setTerminalTitle(`mission-control \u2014 ${options?.sessionID ?? 'session'}`);

    const waitForEvent = (): Promise<ChatInputEvent> => {
        const queued = core.eventQueue.shift();
        if (queued !== undefined) {
            return Promise.resolve(queued);
        }
        return new Promise<ChatInputEvent>((resolve) => {
            core.eventWaiters.push(resolve);
        });
    };

    let emitOutputScheduled = false;
    const emitOutput = (text: string): void => {
        core.outputText += text;
        if (!emitOutputScheduled) {
            emitOutputScheduled = true;
            setTimeout(() => {
                emitOutputScheduled = false;
                publishSnapshot(core);
            }, 16);
        }
    };

    const replaceOutputText = (text: string): void => replaceCoreOutputText(core, text);

    const getOutput = (): string => core.outputText;

    const showModelPicker = (choices: readonly ModelChoice[]): Promise<ModelProviderSelection | undefined> => {
        if (choices.length === 0) {
            return Promise.resolve(undefined);
        }
        core.modelPickerChoices = choices;
        core.modelPickerKeypress = createProviderPromptKeypressState();
        core.modelPickerActive = true;
        publishSnapshot(core);
        return new Promise<ModelProviderSelection | undefined>((resolve) => {
            core.modelPickerResolve = resolve;
        });
    };

    const showLevelPicker = (currentLevel?: string): Promise<string | undefined> => {
        const levels = ['verbose', 'safe', 'aggressive', 'reckless', 'yolo'];
        const currentIdx = currentLevel !== undefined ? levels.indexOf(currentLevel) : -1;
        core.levelPickerSelectedIndex = currentIdx >= 0 ? currentIdx : 1;
        core.levelPickerActive = true;
        publishSnapshot(core);
        return new Promise<string | undefined>((resolve) => {
            core.levelPickerResolve = resolve;
        });
    };

    const setApprovalLevel = (level: ApprovalLevel | undefined): void => {
        core.approvalLevel = level;
        publishSnapshot(core);
    };

    const setModelCycleChoices = (choices: readonly ModelChoice[]): void => {
        core.modelCycleChoices = choices;
        if (core.modelCycleIndex >= choices.length) {
            core.modelCycleIndex = 0;
        }
        publishSnapshot(core);
    };

    const setGenerating = (value: boolean): void => {
        core.generating = value;
        publishSnapshot(core);
    };

    const setWorkflowNames = (names: readonly string[]): void => {
        core.workflowNames = names;
        publishSnapshot(core);
    };

    const setAgentStatus = (text: string): void => {
        core.agentStatusText = text;
        publishSnapshot(core);
    };

    const clearAgentStatus = (): void => {
        core.agentStatusText = '';
        publishSnapshot(core);
    };

    const isShowThinking = (): boolean => core.showThinking;

    const isToolOutputExpanded = (): boolean => core.toolOutputExpanded;

    const applyAbgOverlayPrefs = (prefs: {
        readonly activeTabIndex: number;
        readonly scrollOffset: number;
        readonly liveOutput: boolean;
        readonly showThinking: boolean;
        readonly toolOutputExpanded: boolean;
    }): void => {
        core.abgOverlayActiveTab = prefs.activeTabIndex;
        core.abgOverlayScrollOffset = prefs.scrollOffset;
        core.abgOverlayLiveOutput = prefs.liveOutput;
        core.showThinking = prefs.showThinking;
        core.toolOutputExpanded = prefs.toolOutputExpanded;
    };

    const getAbgOverlayPrefsSnapshot = (): {
        readonly activeTabIndex: number;
        readonly scrollOffset: number;
        readonly liveOutput: boolean;
        readonly showThinking: boolean;
        readonly toolOutputExpanded: boolean;
    } => ({
        activeTabIndex: core.abgOverlayActiveTab,
        scrollOffset: core.abgOverlayScrollOffset,
        liveOutput: core.abgOverlayLiveOutput,
        showThinking: core.showThinking,
        toolOutputExpanded: core.toolOutputExpanded,
    });

    const showApproval = (toolName: string, action: string): void => {
        core.approvalActive = true;
        core.approvalToolName = toolName;
        core.approvalAction = action;
        core.approvalSelectedIndex = 0;
        publishSnapshot(core);
    };

    const hideApproval = (): void => {
        core.approvalActive = false;
        publishSnapshot(core);
    };

    const showQuestion = (
        question: string,
        options: readonly (string | QuestionOption)[],
        metadata?: { readonly header?: string; readonly multiple?: boolean },
    ): Promise<string> => {
        core.questionActive = true;
        core.questionText = question;
        core.questionHeader = metadata?.header ?? '';
        core.questionOptions = normalizeQuestionOptions(options);
        core.questionSelectedIndex = 0;
        core.questionMultiple = metadata?.multiple ?? false;
        core.questionSelectedIndices = new Set<number>();
        core.questionCustomMode = false;
        core.questionCustomBuffer = '';
        publishSnapshot(core);
        return new Promise<string>((resolve) => {
            core.questionResolve = resolve;
        });
    };

    const unmount = (): void => {
        core.unmountFn?.();
        if (titleWasSet) {
            resetTerminalTitle();
        }
    };

    return {
        waitForEvent,
        emitOutput,
        replaceOutputText,
        getOutput,
        showModelPicker,
        showLevelPicker,
        setApprovalLevel,
        setModelCycleChoices,
        get onModelCycleSelect(): ((selection: ModelProviderSelection) => void) | undefined {
            return core.onModelCycleSelect;
        },
        set onModelCycleSelect(value: (selection: ModelProviderSelection) => void) {
            core.onModelCycleSelect = value;
        },
        get onRenameSubmit(): ((name: string) => void) | undefined {
            return core.onRenameSubmit;
        },
        set onRenameSubmit(value: (name: string) => void) {
            core.onRenameSubmit = value;
        },
        setGenerating,
        setWorkflowNames,
        setAgentStatus,
        clearAgentStatus,
        isShowThinking,
        isToolOutputExpanded,
        applyAbgOverlayPrefs,
        getAbgOverlayPrefsSnapshot,
        showApproval,
        hideApproval,
        showQuestion,
        unmount,
    };
}

export type ChatBlock = {
    readonly kind: 'user' | 'assistant' | 'error' | 'system' | 'tool' | 'thinking';
    readonly lines: readonly string[];
    /** Set when this block was tail-sliced or dropped for line budget (truncation marker). */
    readonly truncated?: boolean;
};

const TOOL_LINE_PREFIXES: readonly string[] = [
    'Applied patch: ',
    'Applied edit: ',
    'Created file: ',
    'Replaced file: ',
    'Command output for ',
    'tool: ',
    '[Ctrl+O to expand/collapse]',
    'Edit preview for ',
    'Patch preview for ',
    'Command preview for ',
    'Write preview for ',
    'Replace preview for ',
    'Create preview for ',
];

const TOOL_FAILURE_PATTERN = /^[A-Za-z][\w.-]* failed: /u;
const TOOL_SUMMARY_PATTERN = /^\u2713 \d+ tools? /u;
const THINKING_PREFIX = 'Thinking: ';

function classifyLine(line: string): ChatBlock['kind'] {
    if (line.startsWith('You: ')) return 'user';
    if (line.startsWith('Assistant: ')) return 'assistant';
    if (line.startsWith('Error: ')) return 'error';
    if (line.startsWith(THINKING_PREFIX)) return 'thinking';
    if (TOOL_FAILURE_PATTERN.test(line)) return 'tool';
    if (TOOL_SUMMARY_PATTERN.test(line)) return 'tool';
    if (TOOL_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))) return 'tool';
    return 'system';
}

function isStrongBoundary(kind: ChatBlock['kind']): boolean {
    return kind === 'user' || kind === 'assistant' || kind === 'error' || kind === 'thinking';
}

/** Drop trailing empty lines so a block never ends on a blank (interior blanks survive as paragraph separators). */
function trimTrailingEmptyLines(lines: readonly string[]): readonly string[] {
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? '').length === 0) {
        end -= 1;
    }
    return lines.slice(0, end);
}

export function parseMessageBlocks(outputText: string): readonly ChatBlock[] {
    // Split without dropping empty lines: interior blanks are markdown paragraph
    // separators and must survive so a joined assistant block reconstructs the
    // original multi-paragraph text. Leading/trailing empties that would produce
    // an empty block are trimmed at flush.
    const rawLines = outputText.split('\n');
    const blocks: ChatBlock[] = [];
    let currentKind: ChatBlock['kind'] | undefined;
    let currentLines: string[] = [];

    const flush = (): void => {
        if (currentKind !== undefined && currentLines.length > 0) {
            const trimmed = trimTrailingEmptyLines(currentLines);
            if (trimmed.length > 0) {
                blocks.push({ kind: currentKind, lines: trimmed });
            }
        }
        currentKind = undefined;
        currentLines = [];
    };

    for (const line of rawLines) {
        const classified = classifyLine(line);
        // Continuation absorption keeps multi-line blocks together. Tool blocks
        // absorb any non-strong-boundary line (unchanged). Assistant and thinking
        // blocks absorb plain-text continuation + blank lines (system-classified)
        // so a multi-paragraph message stays one block, but they do NOT absorb
        // tool/user/error/thinking lines, which start new blocks instead.
        const absorbable =
            currentKind !== undefined &&
            ((currentKind === 'tool' && !isStrongBoundary(classified)) ||
                ((currentKind === 'assistant' || currentKind === 'thinking') && classified === 'system'));
        if (absorbable) {
            currentLines.push(line);
            continue;
        }
        if (classified !== currentKind) {
            flush();
            currentKind = classified;
        }
        currentLines.push(line);
    }
    flush();
    return blocks;
}

const blockLeftColor: Record<ChatBlock['kind'], string | undefined> = {
    user: 'cyan',
    assistant: 'green',
    error: 'red',
    system: undefined,
    tool: 'yellow',
    thinking: 'magenta',
};

const blockPrefix: Record<ChatBlock['kind'], string> = {
    user: 'You: ',
    assistant: 'Assistant: ',
    error: 'Error: ',
    system: '',
    tool: '',
    thinking: THINKING_PREFIX,
};

// Thinking blocks render as italic, dimmed markdown: defaultTextStyle layers
// under every element style so prose, headings, and list items all read italic
// without losing their per-element coloring. Requires Markdown's defaultTextStyle
// support (see tokenToBlocks in Markdown.tsx).
const thinkingTheme: TerminalMarkdownTheme = { ...darkTheme, defaultTextStyle: { italic: true, dimColor: true } };

function terminalContentWidth(): number {
    // Subtract 1 from the terminal width to prevent lines from filling the
    // last column. Lines that fill every column (e.g. the StatusSeparator's
    // ─ run, or a markdown table border) trigger implicit autowrap on some
    // terminals/tmux/screen configurations. The resulting phantom line
    // desyncs Ink's line counting from the actual visible line count,
    // scattering characters across the screen on every re-render.
    return Math.max(1, (process.stdout.columns ?? 80) - 1);
}

/** Join a block's lines into one markdown document, stripping the prefix from the first line only. */
function joinBlockText(lines: readonly string[], prefix: string): string {
    if (lines.length === 0) return '';
    const first = lines[0] ?? '';
    const rest = lines.slice(1);
    const strippedFirst = prefix.length > 0 && first.startsWith(prefix) ? first.slice(prefix.length) : first;
    return rest.length === 0 ? strippedFirst : [strippedFirst, ...rest].join('\n');
}

function MarkdownPanel({
    text,
    theme,
    barColor,
    barWidth,
    streaming,
    marginTop,
}: {
    readonly text: string;
    readonly theme: TerminalMarkdownTheme;
    readonly barColor: string;
    readonly barWidth: number;
    readonly streaming?: boolean;
    readonly marginTop?: number;
}): React.ReactNode {
    const width = Math.max(1, terminalContentWidth() - barWidth);
    // Match the bar height to the exact rendered line count: getCachedBlocks
    // returns the same IR <Markdown> will render (cache hit), so summing block
    // lines yields a bar that spans the full content height. An empty bar Box
    // does not reliably flex-stretch across multi-block markdown.
    const rendered = getCachedBlocks(text, width, streaming ?? false, theme);
    const barRows = rendered.reduce((sum, block) => sum + block.lines.length, 0);
    const barBg = toOpenTuiColor(barColor);
    return (
        <box flexDirection="row" {...(marginTop !== undefined ? { marginTop } : {})}>
            <box width={barWidth} flexDirection="column">
                {Array.from({ length: barRows }, (_value, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: bar rows mirror markdown line count
                    <text key={`bar-${index}`} {...(barBg !== undefined ? { bg: barBg } : {})}>
                        {' '.repeat(barWidth)}
                    </text>
                ))}
            </box>
            <box flexDirection="column" flexGrow={1}>
                <Markdown
                    text={text}
                    width={width}
                    theme={theme}
                    selectable={true}
                    {...(streaming ? { streaming: true } : {})}
                />
            </box>
        </box>
    );
}

function MessageBlock({
    block,
    isStreaming,
    toolOutputExpanded,
}: {
    readonly block: ChatBlock;
    readonly isStreaming?: boolean;
    readonly toolOutputExpanded: boolean;
}): React.ReactNode {
    const prefix = blockPrefix[block.kind];

    if (block.kind === 'system') {
        return (
            <box flexDirection="column">
                {block.lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                    <text key={`sys-${index}`} selectable {...toOpenTuiAttributes({ dimColor: true })}>
                        {line}
                    </text>
                ))}
            </box>
        );
    }

    if (block.kind === 'tool') {
        // Redaction invariant: block.lines come from already-redacted chatOutput
        // text (interactive-coding-tool-preview.ts redacts via redactCredentialText
        // before writing). The renderer never reads raw provider or tool output.
        const title = readToolBlockTitle(block.lines);
        return (
            <box marginTop={1}>
                <ToolCard
                    lines={block.lines}
                    expanded={toolOutputExpanded}
                    {...(title !== undefined ? { title } : {})}
                />
            </box>
        );
    }

    if (block.kind === 'thinking') {
        // Redaction invariant: block.lines come from already-redacted chatOutput
        // text (see provider-turn-events.ts / interactive-coding-agent.ts). The
        // renderer never reads raw provider or tool structured output.
        const joined = joinBlockText(block.lines, prefix);
        return (
            <MarkdownPanel
                text={joined}
                theme={thinkingTheme}
                barColor="magenta"
                barWidth={2}
                marginTop={1}
                {...(isStreaming ? { streaming: true } : {})}
            />
        );
    }

    if (block.kind === 'assistant') {
        // Redaction invariant: block.lines come from already-redacted chatOutput
        // text (see provider-turn-events.ts / interactive-coding-agent.ts). The
        // renderer never reads raw provider or tool structured output.
        const joined = joinBlockText(block.lines, prefix);
        return (
            <MarkdownPanel
                text={joined}
                theme={darkTheme}
                barColor="green"
                barWidth={1}
                {...(isStreaming ? { streaming: true } : {})}
            />
        );
    }

    // user / error fallthrough
    const leftColor = blockLeftColor[block.kind];
    const isError = block.kind === 'error';
    const leftBg = leftColor !== undefined ? toOpenTuiColor(leftColor) : undefined;
    return (
        <box flexDirection="row">
            {leftBg !== undefined ? (
                <box width={1} flexDirection="column">
                    {block.lines.map((_line, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                        <text key={`bar-${index}`} bg={leftBg}>
                            {' '}
                        </text>
                    ))}
                </box>
            ) : null}
            <box flexDirection="column" flexGrow={1}>
                {block.lines.map((line, index) => {
                    const content = prefix.length > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line;
                    return (
                        <text
                            selectable
                            // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                            key={`line-${index}`}
                            {...(isError ? { fg: '#ff0000' } : {})}
                        >
                            {content}
                        </text>
                    );
                })}
            </box>
        </box>
    );
}

const TOOL_TITLE_PATTERN = /^(?:Edit|Patch|Command|Write|Replace|Create) preview for (\S+)/u;
const TOOL_TITLE_PATTERN_2 = /^(?:Applied (?:patch|edit):|Created file:|Replaced file:|Command output for) (.+)$/u;

function readToolBlockTitle(lines: readonly string[]): string | undefined {
    for (const line of lines) {
        const match1 = TOOL_TITLE_PATTERN.exec(line);
        if (match1 !== null) {
            return match1[1];
        }
        const match2 = TOOL_TITLE_PATTERN_2.exec(line);
        if (match2 !== null) {
            return match2[1];
        }
        if (line.startsWith('tool: ')) {
            return line.slice(6);
        }
    }
    return undefined;
}

function MessageWindow({
    blocks,
    scrollboxRef,
    generating,
    toolOutputExpanded,
}: {
    readonly blocks: readonly ChatBlock[];
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly generating: boolean;
    readonly toolOutputExpanded: boolean;
}): React.ReactNode {
    // No JS-side windowing: opentui's ScrollBoxRenderable renders only visible
    // children, and stickyScroll (in ChatTranscript) pins streaming to the
    // bottom. Imperative Home/End/PgUp/PgDn reach the scrollbox via scrollboxRef.
    if (blocks.length === 0) {
        return <></>;
    }
    const lastIndex = blocks.length - 1;
    return (
        <ChatTranscript scrollboxRef={scrollboxRef}>
            {blocks.map((block, index) => {
                const streaming = generating && index === lastIndex;
                return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                    <MessageBlock key={`msg-${block.kind}-${index}`} block={block} toolOutputExpanded={toolOutputExpanded} {...(streaming ? { isStreaming: true } : {})} />
                );
            })}
        </ChatTranscript>
    );
}

// Rendered outside core.outputText so it cannot accumulate as ghost text when
// the scrollback grows past the terminal viewport (root cause of the stacking
// bug). Provider/model/session info mirrors StatusBar props.
function Banner({ statusBarProps }: { readonly statusBarProps?: OpenTuiChatBridgeOptions }): React.ReactNode {
    if (statusBarProps === undefined) {
        return <text {...toOpenTuiAttributes({ bold: true })}>{'mission-control chat'}</text>;
    }
    const selection = formatSelectionLabel(statusBarProps);
    return (
        <box flexDirection="column">
            <text {...toOpenTuiAttributes({ bold: true })}>{'mission-control chat'}</text>
            <text {...toOpenTuiAttributes({ dimColor: true })}>{selection}</text>
        </box>
    );
}

function formatSelectionLabel(props: OpenTuiChatBridgeOptions): string {
    const parts = [`provider: ${props.providerID}`, `model: ${props.modelID}`];
    if (props.variantID !== undefined) {
        parts.push(`variant: ${props.variantID}`);
    }
    if (props.sessionID !== undefined) {
        parts.push(`session: ${props.sessionID}`);
    }
    return parts.join(' | ');
}

export function resolveSeparatorState(snapshot: BridgeSnapshot): SeparatorState {
    if (snapshot.generating) {
        return 'running';
    }
    if (snapshot.approvalActive || snapshot.questionActive) {
        return 'awaiting_input';
    }
    return 'idle';
}
