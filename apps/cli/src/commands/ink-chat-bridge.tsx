/**
 * Spike bridge between Ink's React component tree and the imperative chat loop.
 *
 * Architecture: `render(<ChatRoot />)` is called once inside `createInkChatBridge`.
 * Inside `ChatRoot`, `useInput` feeds keystrokes into `handleInput`, which mutates
 * the bridge core's input buffer and enqueues `ChatInputEvent`s. The imperative
 * `runInteractiveChatSession` loop `await`s events from `bridge.waitForEvent()`.
 *
 * The bridge core is the single source of truth for mutable state (input buffer,
 * output text, event queue, event waiters, slash command menu state, model picker
 * state). `ChatRoot` subscribes to it via `useSyncExternalStore` purely for
 * rendering, so `useInput` always reads fresh state from the core and never closes
 * over a stale React snapshot.
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

import type { ModelProviderSelection } from '@mission-control/protocol';
import { Box, type Key, render, Text, useInput } from 'ink';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AbgOverlay, type AbgOverlayTab } from '../components/AbgOverlay.js';
import { StatusBar } from '../components/StatusBar.js';
import type { AbgOverlayController } from './abg-overlay-controller.js';
import {
    createProviderPromptKeypressState,
    createProviderPromptView,
    type ProviderPromptKeypressState,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    reduceSlashCommandMenuSelection,
    resolveSlashCommandMenuSubmission,
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
    readonly scrollOffset: number;
    readonly abgOverlayActive: boolean;
    readonly abgOverlayActiveTab: number;
    readonly abgOverlayScrollOffset: number;
    readonly abgOverlayLiveOutput: boolean;
};

/** Public surface consumed by the imperative chat loop. */
export type InkChatBridge = {
    readonly waitForEvent: () => Promise<ChatInputEvent>;
    readonly emitOutput: (text: string) => void;
    readonly replaceOutputText: (text: string) => void;
    readonly getOutput: () => string;
    readonly showModelPicker: (choices: readonly ModelChoice[]) => Promise<ModelProviderSelection | undefined>;
    readonly showLevelPicker: (currentLevel?: string) => Promise<string | undefined>;
    readonly setModelCycleChoices: (choices: readonly ModelChoice[]) => void;
    onModelCycleSelect: ((selection: ModelProviderSelection) => void) | undefined;
    onRenameSubmit: ((name: string) => void) | undefined;
    readonly setGenerating: (value: boolean) => void;
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
export type InkChatBridgeOptions = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
    readonly workspaceRoot?: string;
    readonly initialHistoryEntries?: readonly string[];
    readonly abgOverlayController?: AbgOverlayController;
};

export type InkChatBridgeCore = {
    inputBuffer: string;
    cursorPosition: number;
    outputText: string;
    menuState: SlashCommandMenuState;
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
    scrollOffset: number;
    lastEscTimestamp: number | undefined;
    cjkCompositionBuffer: string;
    cjkCompositionTimer: ReturnType<typeof setTimeout> | undefined;
    abgOverlayActive: boolean;
    abgOverlayActiveTab: number;
    abgOverlayScrollOffset: number;
    abgOverlayLiveOutput: boolean;
    abgOverlayController: AbgOverlayController | undefined;
};

/** Minimal props the React tree uses to talk to the bridge core. */
type ChatRootProps = {
    readonly bridge: {
        readonly subscribe: (listener: () => void) => () => void;
        readonly getSnapshot: () => BridgeSnapshot;
        readonly handleInput: (input: string, key: Key) => void;
        readonly abgOverlayController?: AbgOverlayController;
    };
    readonly statusBarProps?: InkChatBridgeOptions;
};

const slashMenuMaxVisibleChoices = 5;
const modelPickerMaxVisibleChoices = 10;
const fileAutocompleteMaxVisibleChoices = 8;
const SCROLL_PAGE_SIZE = 10;
const SCROLLBACK_VIEWPORT_HEIGHT = 20;
const SCROLL_TOP_OFFSET = Number.MAX_SAFE_INTEGER;
const WHITESPACE_PATTERN = /\s/u;
const DOUBLE_ESC_WINDOW_MS = 500;
const DOUBLE_ESC_ACTION_ENV = 'MCTRL_DOUBLE_ESC_ACTION';

export function publishSnapshot(core: InkChatBridgeCore): void {
    const historyNavigation = isNavigatingChatInputHistory(core.history)
        ? { position: core.history.cursor + 1, total: core.history.entries.length }
        : null;
    core.snapshot = {
        inputBuffer: core.inputBuffer,
        cursorPosition: core.cursorPosition,
        outputText: core.outputText,
        menuState: core.menuState,
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
        scrollOffset: core.scrollOffset,
        abgOverlayActive: core.abgOverlayActive,
        abgOverlayActiveTab: core.abgOverlayActiveTab,
        abgOverlayScrollOffset: core.abgOverlayScrollOffset,
        abgOverlayLiveOutput: core.abgOverlayLiveOutput,
    };
    for (const listener of core.listeners) {
        listener();
    }
}

function enqueueEvent(core: InkChatBridgeCore, event: ChatInputEvent): void {
    const waiter = core.eventWaiters.shift();
    if (waiter !== undefined) {
        waiter(event);
        return;
    }
    core.eventQueue.push(event);
}

/** Ctrl+Left semantics: skip whitespace leftward, then skip the word's chars. */
function computeWordBoundaryLeft(buffer: string, cursor: number): number {
    let pos = cursor;
    while (pos > 0 && isWhitespaceChar(buffer[pos - 1] ?? '')) {
        pos -= 1;
    }
    while (pos > 0 && !isWhitespaceChar(buffer[pos - 1] ?? '')) {
        pos -= 1;
    }
    return pos;
}

/** Ctrl+Right semantics: skip the word's chars rightward, then skip whitespace. */
function computeWordBoundaryRight(buffer: string, cursor: number): number {
    let pos = cursor;
    const length = buffer.length;
    while (pos < length && !isWhitespaceChar(buffer[pos] ?? '')) {
        pos += 1;
    }
    while (pos < length && isWhitespaceChar(buffer[pos] ?? '')) {
        pos += 1;
    }
    return pos;
}

function isWhitespaceChar(value: string): boolean {
    return WHITESPACE_PATTERN.test(value);
}

function insertAtCursor(core: InkChatBridgeCore, text: string): void {
    core.inputBuffer = `${core.inputBuffer.slice(0, core.cursorPosition)}${text}${core.inputBuffer.slice(core.cursorPosition)}`;
    core.cursorPosition += text.length;
}

const CJK_BUFFER_MS = 50;

const CJK_RANGES: readonly { readonly start: number; readonly end: number }[] = [
    { start: 0x1100, end: 0x11ff }, // Hangul Jamo
    { start: 0x3130, end: 0x318f }, // Hangul Compatibility Jamo
    { start: 0xac00, end: 0xd7af }, // Hangul Syllables
    { start: 0x3040, end: 0x309f }, // Hiragana
    { start: 0x30a0, end: 0x30ff }, // Katakana
    { start: 0x4e00, end: 0x9fff }, // CJK Unified Ideographs
    { start: 0x3400, end: 0x4dbf }, // CJK Extension A
    { start: 0xf900, end: 0xfaff }, // CJK Compatibility Ideographs
];

export function isCjkChar(char: string): boolean {
    const code = char.charCodeAt(0);
    return CJK_RANGES.some((range) => code >= range.start && code <= range.end);
}

function flushCjkBuffer(core: InkChatBridgeCore): void {
    if (core.cjkCompositionBuffer.length === 0) {
        return;
    }
    insertAtCursor(core, core.cjkCompositionBuffer);
    core.cjkCompositionBuffer = '';
    if (core.cjkCompositionTimer !== undefined) {
        clearTimeout(core.cjkCompositionTimer);
        core.cjkCompositionTimer = undefined;
    }
    core.menuState = createSlashCommandMenuState();
    refreshFileAutocomplete(core);
    publishSnapshot(core);
}

function readActiveFilePrefix(buffer: string): string | undefined {
    if (buffer.startsWith('/')) {
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

function refreshFileAutocomplete(core: InkChatBridgeCore): void {
    const prefix = readActiveFilePrefix(core.inputBuffer);
    if (prefix === undefined) {
        core.fileAutocomplete = createFileAutocompleteState();
        return;
    }
    core.fileAutocomplete = updateFileAutocomplete(core.fileAutocomplete, prefix, core.workspaceRoot);
}

function applyFileAutocompleteCompletion(core: InkChatBridgeCore): boolean {
    const completed = buildFileAutocompleteCompletion(core.fileAutocomplete);
    if (completed === undefined) {
        return false;
    }
    const atSuffix = `@${core.fileAutocomplete.prefix}`;
    if (!core.inputBuffer.endsWith(atSuffix)) {
        return false;
    }
    const before = core.inputBuffer.slice(0, core.inputBuffer.length - atSuffix.length);
    core.inputBuffer = `${before}@${completed}`;
    core.cursorPosition = core.inputBuffer.length;
    return true;
}

/**
 * Build a fresh bridge core with default initial state. Exported so unit tests
 * can drive `handleInput` against the same initial state the runtime uses.
 */
export function createInkChatBridgeCore(options?: {
    readonly workspaceRoot?: string;
    readonly initialHistoryEntries?: readonly string[];
}): InkChatBridgeCore {
    const workspaceRoot = options?.workspaceRoot ?? process.cwd();
    const history =
        options?.initialHistoryEntries !== undefined
            ? createChatInputHistoryFromEntries(options.initialHistoryEntries)
            : createChatInputHistory();
    return {
        inputBuffer: '',
        cursorPosition: 0,
        outputText: '',
        menuState: createSlashCommandMenuState(),
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
            scrollOffset: 0,
            abgOverlayActive: false,
            abgOverlayActiveTab: 0,
            abgOverlayScrollOffset: 0,
            abgOverlayLiveOutput: false,
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
        scrollOffset: 0,
        lastEscTimestamp: undefined,
        cjkCompositionBuffer: '',
        cjkCompositionTimer: undefined,
        abgOverlayActive: false,
        abgOverlayActiveTab: 0,
        abgOverlayScrollOffset: 0,
        abgOverlayLiveOutput: false,
        abgOverlayController: undefined,
    };
}

/**
 * Replace `core.outputText` entirely and publish a fresh snapshot. Exported
 * so unit tests can verify display truncation without mounting the Ink tree.
 */
export function replaceCoreOutputText(core: InkChatBridgeCore, text: string): void {
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
export function handleSuspendRequest(core: InkChatBridgeCore): void {
    if (suspendControls.isWindowsPlatform()) {
        core.outputText += SUSPEND_UNSUPPORTED_MESSAGE;
        publishSnapshot(core);
        return;
    }
    suspendControls.sendSuspendSignal();
}

/**
 * Handle Ctrl+D (EOT): on an empty buffer, enqueue an interrupt event so the
 * main chat loop exits (same shape as the second Ctrl+C). On a non-empty
 * buffer, forward-delete the character at the cursor (Emacs-style); no-op when
 * the cursor is already at the end.
 */
export function handleCtrlDRequest(core: InkChatBridgeCore): void {
    if (core.inputBuffer.length === 0) {
        enqueueEvent(core, { type: 'interrupt', interruptedPartialInput: false });
        return;
    }
    if (core.cursorPosition < core.inputBuffer.length) {
        core.inputBuffer = `${core.inputBuffer.slice(0, core.cursorPosition)}${core.inputBuffer.slice(core.cursorPosition + 1)}`;
        core.menuState = createSlashCommandMenuState();
        refreshFileAutocomplete(core);
        publishSnapshot(core);
    }
}

/**
 * Handle Ctrl+E: open the current input buffer in an external editor
 * ($VISUAL or $EDITOR). Writes the buffer to a temp file, blocks on the
 * editor via `spawnSync` (`stdio: 'inherit'` so the editor owns the
 * terminal), reads the edited content back, replaces the buffer, and
 * moves the cursor to the end. The temp file is always cleaned up in
 * `finally`. If no editor is configured, writes a guidance message.
 */
export function handleExternalEditorRequest(core: InkChatBridgeCore): void {
    const editor = editorControls.resolveEditor();
    if (editor === undefined) {
        core.outputText += NO_EDITOR_MESSAGE;
        publishSnapshot(core);
        return;
    }
    const tempPath = join(tmpdir(), `mctrl-edit-${Date.now()}.md`);
    writeFileSync(tempPath, core.inputBuffer, 'utf-8');
    try {
        editorControls.runEditor(editor, tempPath);
        const edited = readFileSync(tempPath, 'utf-8');
        core.inputBuffer = edited;
        core.cursorPosition = edited.length;
        core.menuState = createSlashCommandMenuState();
        refreshFileAutocomplete(core);
        publishSnapshot(core);
    } finally {
        unlinkSync(tempPath);
    }
}

/**
 * Handle Ctrl+V: attempt to read a clipboard image and insert its file path
 * into the input buffer. If no image is available or no clipboard tool is
 * installed, silently no-op (the user may have pressed Ctrl+V without an
 * image in the clipboard). On success, inserts the temp file path followed
 * by a space at the cursor position.
 */
export function handleImagePasteRequest(core: InkChatBridgeCore): void {
    const result = clipboardImageControls.readClipboardImage();
    if (result === undefined) {
        return;
    }
    insertAtCursor(core, `${result.path} `);
    publishSnapshot(core);
}

function resolveDoubleEscAction(): 'interrupt' | 'tree' | 'fork' | 'none' {
    const action = process.env[DOUBLE_ESC_ACTION_ENV];
    if (action === 'none') {
        return 'none';
    }
    if (action === 'tree') {
        return 'tree';
    }
    if (action === 'fork') {
        return 'fork';
    }
    return 'interrupt';
}

function handleEscKey(core: InkChatBridgeCore): void {
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
        if (action === 'interrupt') {
            enqueueEvent(core, { type: 'interrupt', interruptedPartialInput: false });
        } else if (action === 'tree') {
            enqueueEvent(core, { type: 'line', value: '/tree' });
        } else {
            enqueueEvent(core, { type: 'line', value: '/fork' });
        }
        publishSnapshot(core);
        return;
    }
    core.lastEscTimestamp = now;
    publishSnapshot(core);
}

function handleModelCycle(core: InkChatBridgeCore, direction: 1 | -1): void {
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

export function handleInput(core: InkChatBridgeCore, input: string, key: Key): void {
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
    if (key.ctrl && input === 'g') {
        flushCjkBuffer(core);
        core.abgOverlayActive = !core.abgOverlayActive;
        if (!core.abgOverlayActive) {
            core.abgOverlayController?.reset();
        }
        publishSnapshot(core);
        return;
    }
    const isCjkPrintable = input !== '' && !key.ctrl && !key.meta && isCjkChar(input);
    if (!isCjkPrintable) {
        flushCjkBuffer(core);
    }
    if (core.abgOverlayActive) {
        handleAbgOverlayInput(core, input, key);
        return;
    }
    if (key.escape || input === '\u001b') {
        handleEscKey(core);
        return;
    }
    if (key.ctrl && input === 'c') {
        const hadPartialInput = core.inputBuffer.length > 0;
        enqueueEvent(core, {
            type: 'interrupt',
            interruptedPartialInput: hadPartialInput,
        });
        if (hadPartialInput) {
            core.inputBuffer = '';
            core.cursorPosition = 0;
            core.menuState = createSlashCommandMenuState();
            core.fileAutocomplete = createFileAutocompleteState();
            publishSnapshot(core);
        }
        return;
    }
    if (key.ctrl && input === 'z') {
        handleSuspendRequest(core);
        return;
    }
    if (key.ctrl && input === 'd') {
        handleCtrlDRequest(core);
        return;
    }
    if (key.ctrl && input === 't') {
        core.showThinking = !core.showThinking;
        publishSnapshot(core);
        return;
    }
    if (key.ctrl && input === 'o') {
        core.toolOutputExpanded = !core.toolOutputExpanded;
        publishSnapshot(core);
        return;
    }
    if (key.ctrl && input === 'p') {
        handleModelCycle(core, key.shift ? -1 : 1);
        return;
    }
    if (key.ctrl && input === 'e') {
        handleExternalEditorRequest(core);
        return;
    }
    if (key.ctrl && input === 'r') {
        core.renameModeActive = true;
        core.renameBuffer = '';
        publishSnapshot(core);
        return;
    }
    if (key.ctrl && input === 'v') {
        handleImagePasteRequest(core);
        return;
    }
    if (key.upArrow) {
        if (core.inputBuffer.startsWith('/')) {
            core.menuState = reduceSlashCommandMenuSelection(core.menuState, '\u001b[A', core.inputBuffer);
        } else if (core.fileAutocomplete.open) {
            core.fileAutocomplete = navigateFileAutocompleteUp(core.fileAutocomplete);
        } else {
            const result = navigateChatInputHistoryUp(core.history, core.inputBuffer);
            core.history = result.history;
            core.inputBuffer = result.input;
            core.cursorPosition = result.input.length;
            core.menuState = createSlashCommandMenuState();
            refreshFileAutocomplete(core);
        }
        publishSnapshot(core);
        return;
    }
    if (key.downArrow) {
        if (core.inputBuffer.startsWith('/')) {
            core.menuState = reduceSlashCommandMenuSelection(core.menuState, '\u001b[B', core.inputBuffer);
        } else if (core.fileAutocomplete.open) {
            core.fileAutocomplete = navigateFileAutocompleteDown(core.fileAutocomplete);
        } else {
            const result = navigateChatInputHistoryDown(core.history, core.inputBuffer);
            core.history = result.history;
            core.inputBuffer = result.input;
            core.cursorPosition = result.input.length;
            core.menuState = createSlashCommandMenuState();
            refreshFileAutocomplete(core);
        }
        publishSnapshot(core);
        return;
    }
    if (key.pageUp) {
        core.scrollOffset += SCROLL_PAGE_SIZE;
        publishSnapshot(core);
        return;
    }
    if (key.pageDown) {
        core.scrollOffset = Math.max(0, core.scrollOffset - SCROLL_PAGE_SIZE);
        publishSnapshot(core);
        return;
    }
    if (key.home) {
        core.scrollOffset = SCROLL_TOP_OFFSET;
        publishSnapshot(core);
        return;
    }
    if (key.end) {
        core.scrollOffset = 0;
        publishSnapshot(core);
        return;
    }
    if (key.ctrl && key.leftArrow) {
        core.cursorPosition = computeWordBoundaryLeft(core.inputBuffer, core.cursorPosition);
        publishSnapshot(core);
        return;
    }
    if (key.ctrl && key.rightArrow) {
        core.cursorPosition = computeWordBoundaryRight(core.inputBuffer, core.cursorPosition);
        publishSnapshot(core);
        return;
    }
    if (key.shift && (key.return || input.includes('\r') || input.includes('\n'))) {
        const textBeforeReturn = input.split(/[\r\n]/)[0] ?? '';
        if (textBeforeReturn.length > 0 && !key.ctrl && !key.meta) {
            insertAtCursor(core, textBeforeReturn);
            core.menuState = createSlashCommandMenuState();
        }
        insertAtCursor(core, '\n');
        refreshFileAutocomplete(core);
        publishSnapshot(core);
        return;
    }
    if (!key.shift && (key.return || input.includes('\r') || input.includes('\n'))) {
        const textBeforeReturn = input.split(/[\r\n]/)[0] ?? '';
        if (textBeforeReturn.length > 0 && !key.ctrl && !key.meta) {
            insertAtCursor(core, textBeforeReturn);
            core.menuState = createSlashCommandMenuState();
        }
        refreshFileAutocomplete(core);
        if (core.fileAutocomplete.open && applyFileAutocompleteCompletion(core)) {
            refreshFileAutocomplete(core);
            publishSnapshot(core);
            return;
        }
        let value = core.inputBuffer;
        if (core.inputBuffer.startsWith('/')) {
            const resolved = resolveSlashCommandMenuSubmission(core.inputBuffer, core.menuState);
            if (resolved !== core.inputBuffer) {
                value = resolved;
            }
        }
        enqueueEvent(core, { type: 'line', value });
        core.inputBuffer = '';
        core.cursorPosition = 0;
        core.menuState = createSlashCommandMenuState();
        core.fileAutocomplete = createFileAutocompleteState();
        core.history = recordSubmittedPrompt(core.history, value);
        if (!value.startsWith('/')) {
            core.outputText += `You: ${value}\n`;
        }
        publishSnapshot(core);
        return;
    }
    if (key.tab && core.fileAutocomplete.open) {
        if (applyFileAutocompleteCompletion(core)) {
            refreshFileAutocomplete(core);
        }
        publishSnapshot(core);
        return;
    }
    if (key.escape && core.fileAutocomplete.open) {
        core.fileAutocomplete = createFileAutocompleteState();
        publishSnapshot(core);
        return;
    }
    if (key.backspace) {
        if (core.cursorPosition > 0) {
            core.inputBuffer = `${core.inputBuffer.slice(0, core.cursorPosition - 1)}${core.inputBuffer.slice(core.cursorPosition)}`;
            core.cursorPosition -= 1;
            core.menuState = createSlashCommandMenuState();
            refreshFileAutocomplete(core);
            publishSnapshot(core);
        }
        return;
    }
    if (input !== '' && !key.ctrl && !key.meta) {
        if (isCjkChar(input)) {
            core.cjkCompositionBuffer += input;
            if (core.cjkCompositionTimer !== undefined) {
                clearTimeout(core.cjkCompositionTimer);
            }
            core.cjkCompositionTimer = setTimeout(() => {
                core.cjkCompositionTimer = undefined;
                flushCjkBuffer(core);
            }, CJK_BUFFER_MS);
            publishSnapshot(core);
        } else {
            if (core.cjkCompositionBuffer.length > 0) {
                flushCjkBuffer(core);
            }
            insertAtCursor(core, input);
            core.menuState = createSlashCommandMenuState();
            refreshFileAutocomplete(core);
            publishSnapshot(core);
        }
    }
}

const approvalOptions = [
    { key: 'once', label: 'Allow once', description: 'allow this request only' },
    { key: 'session', label: 'Allow session', description: 'allow for this session only' },
    { key: 'always', label: 'Always allow', description: 'allow all future matching requests (persisted)' },
    { key: 'deny', label: 'Deny', description: 'block this request' },
] as const;

function handleApprovalInput(core: InkChatBridgeCore, input: string, key: Key): void {
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
function handleQuestionInput(core: InkChatBridgeCore, input: string, key: Key): void {
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

function collectMultiSelectAnswer(core: InkChatBridgeCore): string {
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

function resolveQuestion(core: InkChatBridgeCore, answer: string): void {
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

function handleRenameInput(core: InkChatBridgeCore, input: string, key: Key): void {
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

function handleModelPickerInput(core: InkChatBridgeCore, input: string, key: Key): void {
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

function handleLevelPickerInput(core: InkChatBridgeCore, input: string, key: Key): void {
    if (key.ctrl && input === 'c') {
        core.levelPickerActive = false;
        core.levelPickerResolve?.(undefined);
        core.levelPickerResolve = undefined;
        publishSnapshot(core);
        return;
    }
    if (key.upArrow) {
        core.levelPickerSelectedIndex = (core.levelPickerSelectedIndex - 1 + APPROVAL_LEVEL_PICKER_COUNT) % APPROVAL_LEVEL_PICKER_COUNT;
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
function handleAbgOverlayInput(core: InkChatBridgeCore, input: string, key: Key): void {
    const controller = core.abgOverlayController;

    if ((key.ctrl && input === 'g') || key.escape || input === '\u001b') {
        core.abgOverlayActive = false;
        controller?.reset();
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
        core.abgOverlayScrollOffset += SCROLL_PAGE_SIZE;
        publishSnapshot(core);
        return;
    }
    if (key.pageDown) {
        core.abgOverlayScrollOffset = Math.max(0, core.abgOverlayScrollOffset - SCROLL_PAGE_SIZE);
        publishSnapshot(core);
        return;
    }
    if (key.home) {
        core.abgOverlayScrollOffset = SCROLL_TOP_OFFSET;
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

const SPINNER_FRAMES = [
    '\u280B',
    '\u2819',
    '\u2839',
    '\u2838',
    '\u283C',
    '\u2834',
    '\u2826',
    '\u2827',
    '\u2807',
    '\u280F',
] as const;
const SPINNER_INTERVAL_MS = 80;

function AgentSpinner({ text }: { readonly text: string }): React.ReactElement {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => {
            setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
        }, SPINNER_INTERVAL_MS);
        return () => {
            clearInterval(timer);
        };
    }, []);
    return (
        <Box marginTop={1}>
            <Text color="yellow">{SPINNER_FRAMES[frame]} </Text>
            <Text dimColor>{text}</Text>
        </Box>
    );
}

function ChatRoot({ bridge, statusBarProps }: ChatRootProps) {
    const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
    useInput((input, key) => bridge.handleInput(input, key));

    const messageBlocks = parseMessageBlocks(snapshot.outputText);

    if (snapshot.approvalActive) {
        return (
            <Box flexDirection="column">
                <MessageWindow blocks={messageBlocks} scrollOffset={snapshot.scrollOffset} />
                <Box flexDirection="column" marginTop={1} paddingX={1}>
                    <Text bold color="yellow" inverse>
                        {' Approval Required '}
                    </Text>
                    <Text>
                        <Text bold>Tool:</Text> {snapshot.approvalToolName}
                    </Text>
                    <Text dimColor>{snapshot.approvalAction}</Text>
                    <Box flexDirection="column" marginTop={1}>
                        {approvalOptions.map((option, index) => {
                            const isSelected = index === snapshot.approvalSelectedIndex;
                            return (
                                <Text key={option.key} {...(isSelected ? { backgroundColor: 'blue' } : {})}>
                                    {isSelected ? '> ' : '  '}
                                    {option.label}
                                    {'  '}
                                    <Text dimColor>{option.description}</Text>
                                </Text>
                            );
                        })}
                    </Box>
                    <Box marginTop={1}>
                        <Text dimColor>Up/Down to navigate, Enter to select, Ctrl+C to deny</Text>
                    </Box>
                </Box>
            </Box>
        );
    }

    if (snapshot.questionActive) {
        return (
            <Box flexDirection="column">
                <MessageWindow blocks={messageBlocks} scrollOffset={snapshot.scrollOffset} />
                <Box flexDirection="column" marginTop={1} paddingX={1}>
                    <Text bold color="magenta" inverse>
                        {' Question '}
                    </Text>
                    {snapshot.questionHeader.length > 0 ? <Text bold>{snapshot.questionHeader}</Text> : null}
                    <Text>{snapshot.questionText}</Text>
                    {snapshot.questionCustomMode ? (
                        <>
                            <Box marginTop={1}>
                                <Text>
                                    <Text color="magenta">{'>'}</Text> {snapshot.questionCustomBuffer}
                                    <Text backgroundColor="white" color="black">
                                        {'\u2588'}
                                    </Text>
                                </Text>
                            </Box>
                            <Text dimColor>Enter to submit, Esc to go back to options, Ctrl+C to cancel</Text>
                        </>
                    ) : (
                        <>
                            <Box flexDirection="column" marginTop={1}>
                                {snapshot.questionOptions.map((option, index) => {
                                    const isCursor = index === snapshot.questionSelectedIndex;
                                    const prefix = snapshot.questionMultiple
                                        ? `${snapshot.questionSelectedIndices.has(index) ? '[x] ' : '[ ] '}`
                                        : '';
                                    return (
                                        // biome-ignore lint/suspicious/noArrayIndexKey: question options are positional within a single overlay render
                                        <Box key={`q-opt-${index}-${option.label}`} flexDirection="column">
                                            <Text {...(isCursor ? { backgroundColor: 'blue' } : {})}>
                                                {isCursor ? '> ' : '  '}
                                                {prefix}
                                                {option.label}
                                            </Text>
                                            {option.description !== undefined ? (
                                                <Text dimColor>{`    ${option.description}`}</Text>
                                            ) : null}
                                        </Box>
                                    );
                                })}
                                {snapshot.questionMultiple
                                    ? null
                                    : (() => {
                                          const customIndex = snapshot.questionOptions.length;
                                          const isSelected = customIndex === snapshot.questionSelectedIndex;
                                          return (
                                              <Text {...(isSelected ? { backgroundColor: 'blue' } : {})}>
                                                  {isSelected ? '> ' : '  '}
                                                  <Text dimColor>Type custom answer...</Text>
                                              </Text>
                                          );
                                      })()}
                            </Box>
                            <Text dimColor>
                                {snapshot.questionMultiple
                                    ? 'Up/Down to navigate, Space to toggle, Enter to submit, Esc to cancel'
                                    : 'Up/Down to navigate, Enter to select, Esc to cancel'}
                            </Text>
                        </>
                    )}
                </Box>
            </Box>
        );
    }

    if (snapshot.renameModeActive) {
        return (
            <Box flexDirection="column">
                <MessageWindow blocks={messageBlocks} scrollOffset={snapshot.scrollOffset} />
                <Box flexDirection="column" marginTop={1} paddingX={1}>
                    <Text bold color="cyan" inverse>
                        {' Rename Session '}
                    </Text>
                    <Text>Enter new session name:</Text>
                    <Text>
                        <Text color="cyan">{'>'}</Text> {snapshot.renameBuffer}
                        <Text backgroundColor="white" color="black">
                            {'\u2588'}
                        </Text>
                    </Text>
                    <Text dimColor>Enter to confirm, Esc to cancel</Text>
                </Box>
            </Box>
        );
    }

    if (snapshot.levelPickerActive) {
        const levels: ReadonlyArray<{ readonly id: string; readonly label: string; readonly desc: string }> = [
            { id: 'verbose', label: 'verbose', desc: 'Ask for every tool call, including reads' },
            { id: 'safe', label: 'safe', desc: 'Auto-approve reads and webfetch; ask before modifications' },
            { id: 'aggressive', label: 'aggressive', desc: 'Auto-approve reads, edits, webfetch, subagent; ask before bash' },
            { id: 'reckless', label: 'reckless', desc: 'Auto-approve everything; only bash asks before execution' },
            { id: 'yolo', label: 'yolo', desc: 'Auto-approve everything including subagent (use with caution)' },
        ];
        return (
            <Box flexDirection="column">
                <MessageWindow blocks={messageBlocks} scrollOffset={snapshot.scrollOffset} />
                <Box flexDirection="column" marginTop={1} paddingX={1}>
                    <Text bold color="cyan" inverse>
                        {' Select approval level '}
                    </Text>
                    {levels.map((level, index) => {
                        const isSelected = index === snapshot.levelPickerSelectedIndex;
                        return (
                            <Box key={level.id} flexDirection="row">
                                <Text {...(isSelected ? { backgroundColor: 'blue' } : {})}>
                                    {isSelected ? '> ' : '  '}
                                    {level.label.padEnd(13)}
                                </Text>
                                <Text dimColor>{level.desc}</Text>
                            </Box>
                        );
                    })}
                    <Text dimColor>{'Up/Down to navigate, Enter to select, Ctrl+C to cancel'}</Text>
                </Box>
            </Box>
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
            <Box flexDirection="column">
                <Text bold color="cyan">
                    Select model
                </Text>
                <Text dimColor>{`Search: ${view.searchQuery}`}</Text>
                {view.totalCount === 0 ? (
                    <Text dimColor>No models match</Text>
                ) : (
                    <Text dimColor>{`Showing ${view.startIndex + 1}-${view.endIndex} of ${view.totalCount}`}</Text>
                )}
                {view.visibleChoices.map((choice, index) => {
                    const globalIndex = view.startIndex + index;
                    const isSelected = globalIndex === view.selectedIndex;
                    return (
                        <Text key={choice.id} {...(isSelected ? { backgroundColor: 'blue' } : {})}>
                            {isSelected ? '> ' : '  '}
                            {globalIndex + 1}. {choice.name}
                        </Text>
                    );
                })}
                <Text dimColor>Use Up/Down, type to search, Enter to select, Ctrl+C to cancel</Text>
            </Box>
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
                <Box flexDirection="column">
                    <Text color="red">ABG overlay active but store not initialized</Text>
                </Box>
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
    const menuView = showSlashMenu
        ? createSlashCommandMenuView(snapshot.inputBuffer, snapshot.menuState, slashMenuMaxVisibleChoices)
        : null;
    const fileView =
        !showSlashMenu && snapshot.fileAutocomplete.open
            ? createFileAutocompleteView(snapshot.fileAutocomplete, fileAutocompleteMaxVisibleChoices)
            : null;

    return (
        <Box flexDirection="column">
            <Banner {...(statusBarProps !== undefined ? { statusBarProps } : {})} />
            <MessageWindow blocks={messageBlocks} scrollOffset={snapshot.scrollOffset} />
            {snapshot.agentStatusText.length > 0 ? (
                <AgentSpinner text={snapshot.agentStatusText} />
            ) : snapshot.generating ? (
                <Box marginTop={1}>
                    <Text color="yellow">{'\u25CF Thinking...'}</Text>
                </Box>
            ) : null}
            {menuView !== null && menuView.open ? (
                <Box flexDirection="column" marginTop={1}>
                    {menuView.empty ? (
                        <Text dimColor> no commands match</Text>
                    ) : (
                        menuView.visibleChoices.map((choice, index) => {
                            const globalIndex = menuView.startIndex + index;
                            const isSelected = globalIndex === menuView.selectedIndex;
                            return (
                                <Text key={choice.id} {...(isSelected ? { backgroundColor: 'blue' } : {})}>
                                    {isSelected ? '> ' : '  '}
                                    {choice.id.padEnd(13)} {choice.description}
                                </Text>
                            );
                        })
                    )}
                </Box>
            ) : null}
            {fileView?.open ? (
                <Box flexDirection="column" marginTop={1}>
                    <Text dimColor>{`Files matching @${fileView.prefix}`}</Text>
                    {fileView.empty ? (
                        <Text dimColor> no files match</Text>
                    ) : (
                        fileView.visibleMatches.map((match, index) => {
                            const globalIndex = fileView.startIndex + index;
                            const isSelected = globalIndex === fileView.selectedIndex;
                            const marker = match.isDirectory ? '/' : ' ';
                            return (
                                <Text key={match.name} {...(isSelected ? { backgroundColor: 'blue' } : {})}>
                                    {isSelected ? '> ' : '  '}
                                    {marker}
                                    {match.name}
                                </Text>
                            );
                        })
                    )}
                    <Text dimColor>Tab/Enter to complete, Up/Down to navigate, Esc to close</Text>
                </Box>
            ) : null}
            <Box flexDirection="column" marginTop={1}>
                <Text dimColor>{'-'.repeat(process.stdout.columns ?? 80)}</Text>
                <Text>
                    <Text color="cyan">{'>'}</Text> {snapshot.inputBuffer.slice(0, snapshot.cursorPosition)}
                    <Text backgroundColor="white" color="black">
                        {'\u2588'}
                    </Text>
                    {snapshot.inputBuffer.slice(snapshot.cursorPosition)}
                    {snapshot.historyNavigation !== null ? (
                        <Text dimColor>
                            {' '}
                            {`[history ${snapshot.historyNavigation.position}/${snapshot.historyNavigation.total} — ↑/↓ to recall, Enter to use]`}
                        </Text>
                    ) : snapshot.inputBuffer.length === 0 ? (
                        <Text dimColor> Type a message, / for commands, or Ctrl+C twice to exit</Text>
                    ) : null}
                </Text>
            </Box>
            {statusBarProps !== undefined ? (
                <Box marginTop={1}>
                    <StatusBar {...statusBarProps} />
                </Box>
            ) : null}
        </Box>
    );
}

/**
 * Mount the Ink tree once and return the imperative bridge. Callers `await`
 * `waitForEvent()` to consume `{ type: 'line' }` / `{ type: 'interrupt' }`
 * events, `emitOutput()` to append chat output, `showModelPicker()` to open the
 * `/model` selection overlay, and `unmount()` to tear down.
 */
export function createInkChatBridge(options?: InkChatBridgeOptions): InkChatBridge {
    const core = createInkChatBridgeCore({
        ...(options?.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options?.initialHistoryEntries !== undefined
            ? { initialHistoryEntries: options.initialHistoryEntries }
            : {}),
    });
    if (options?.abgOverlayController !== undefined) {
        core.abgOverlayController = options.abgOverlayController;
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
        ...(core.abgOverlayController !== undefined ? { abgOverlayController: core.abgOverlayController } : {}),
    };

    const instance = render(
        <ChatRoot bridge={internalBridge} {...(options !== undefined ? { statusBarProps: options } : {})} />,
        { exitOnCtrlC: false },
    );
    core.unmountFn = instance.unmount;
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

export function parseMessageBlocks(outputText: string): readonly ChatBlock[] {
    const rawLines = outputText.split('\n').filter((line) => line.length > 0);
    const blocks: ChatBlock[] = [];
    let currentKind: ChatBlock['kind'] | undefined;
    let currentLines: string[] = [];

    const flush = (): void => {
        if (currentKind !== undefined && currentLines.length > 0) {
            blocks.push({ kind: currentKind, lines: currentLines });
        }
        currentKind = undefined;
        currentLines = [];
    };

    for (const line of rawLines) {
        const classified = classifyLine(line);
        if (currentKind === 'tool' && !isStrongBoundary(classified)) {
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

function MessageBlock({ block }: { readonly block: ChatBlock }): React.ReactElement {
    const leftColor = blockLeftColor[block.kind];
    const prefix = blockPrefix[block.kind];
    const isSystem = block.kind === 'system';
    const isTool = block.kind === 'tool';
    const isThinking = block.kind === 'thinking';

    if (isSystem) {
        return (
            <Box flexDirection="column">
                {block.lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                    <Text key={`sys-${index}`} dimColor>
                        {line}
                    </Text>
                ))}
            </Box>
        );
    }

    if (isTool) {
        const title = readToolBlockTitle(block.lines);
        return (
            <Box flexDirection="row" marginTop={1}>
                <Box width={2} flexDirection="column">
                    {block.lines.map((_line, index) => (
                        <Text key={`bar-${index}`} backgroundColor="yellow">
                            {'  '}
                        </Text>
                    ))}
                </Box>
                <Box flexDirection="column" flexGrow={1}>
                    {title !== undefined ? (
                        <Text color="yellow" bold>
                            {`> ${title}`}
                        </Text>
                    ) : null}
                    {block.lines.map((line, index) => (
                        <Text key={`line-${index}`} color="yellow">
                            {line}
                        </Text>
                    ))}
                </Box>
            </Box>
        );
    }

    if (isThinking) {
        return (
            <Box flexDirection="row" marginTop={1}>
                <Box width={2} flexDirection="column">
                    {block.lines.map((_line, index) => (
                        <Text key={`bar-${index}`} backgroundColor="magenta">
                            {'  '}
                        </Text>
                    ))}
                </Box>
                <Box flexDirection="column" flexGrow={1}>
                    {block.lines.map((line, index) => {
                        const content = line.startsWith(THINKING_PREFIX)
                            ? line.slice(THINKING_PREFIX.length)
                            : line;
                        return (
                            <Text key={`line-${index}`} italic dimColor>
                                {content}
                            </Text>
                        );
                    })}
                </Box>
            </Box>
        );
    }

    return (
        <Box flexDirection="row">
            {leftColor !== undefined ? (
                <Box width={1} flexDirection="column">
                    {block.lines.map((_line, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                        <Text key={`bar-${index}`} backgroundColor={leftColor}>
                            {' '}
                        </Text>
                    ))}
                </Box>
            ) : null}
            <Box flexDirection="column" flexGrow={1}>
                {block.lines.map((line, index) => {
                    const content = prefix.length > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line;
                    const isError = block.kind === 'error';
                    return (
                        <Text
                            // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                            key={`line-${index}`}
                            {...(isError ? { color: 'red' } : {})}
                            {...(block.kind === 'assistant' ? { dimColor: true } : {})}
                        >
                            {content}
                        </Text>
                    );
                })}
            </Box>
        </Box>
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

// 1 banner + 1 separator + 1 input + 1 statusbar + ~4 padding/spinner buffer.
const MESSAGE_WINDOW_CHROME_LINES = 8;
const MESSAGE_WINDOW_FALLBACK_ROWS = 24;
const MESSAGE_WINDOW_MIN_LINES = 5;

export function getMessageWindowLineBudget(): number {
    const rows = process.stdout.rows ?? MESSAGE_WINDOW_FALLBACK_ROWS;
    return Math.max(MESSAGE_WINDOW_MIN_LINES, rows - MESSAGE_WINDOW_CHROME_LINES);
}

export function selectTrailingBlocks(
    blocks: readonly ChatBlock[],
    lineBudget: number,
): { readonly startIdx: number; readonly windowed: readonly ChatBlock[]; readonly truncatedTop: boolean } {
    if (blocks.length === 0) return { startIdx: 0, windowed: [], truncatedTop: false };
    let lineCount = 0;
    let startIdx = blocks.length - 1;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        if (block === undefined) continue;
        if (lineCount + block.lines.length > lineBudget) {
            const remaining = lineBudget - lineCount;
            if (remaining > 0 && index < blocks.length - 1) {
                const truncatedBlock: ChatBlock = { ...block, lines: block.lines.slice(-remaining) };
                return {
                    startIdx: index,
                    windowed: [truncatedBlock, ...blocks.slice(index + 1)],
                    truncatedTop: true,
                };
            }
            if (remaining > 0 && index === blocks.length - 1) {
                const truncatedBlock: ChatBlock = { ...block, lines: block.lines.slice(-remaining) };
                return { startIdx: index, windowed: [truncatedBlock], truncatedTop: true };
            }
            return { startIdx: index + 1, windowed: blocks.slice(index + 1), truncatedTop: index >= 0 };
        }
        lineCount += block.lines.length;
        startIdx = index;
    }
    return { startIdx, windowed: blocks.slice(startIdx), truncatedTop: startIdx > 0 };
}

function MessageWindow({
    blocks,
    scrollOffset,
}: {
    readonly blocks: readonly ChatBlock[];
    readonly scrollOffset: number;
}): React.ReactElement {
    const total = blocks.length;
    if (total === 0) {
        return <></>;
    }
    const lineBudget = getMessageWindowLineBudget();

    if (scrollOffset <= 0) {
        const { startIdx, windowed, truncatedTop } = selectTrailingBlocks(blocks, lineBudget);
        const hidden = startIdx;
        const showTruncationHint = hidden > 0 || truncatedTop;
        return (
            <>
                {showTruncationHint ? (
                    <Text dimColor>{`[\u2191 earlier output hidden \u2014 PgUp to scroll]`}</Text>
                ) : null}
                {windowed.map((block, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                    <MessageBlock key={`msg-${block.kind}-${startIdx + index}`} block={block} />
                ))}
            </>
        );
    }

    const clampedOffset = Math.min(scrollOffset, total);
    const endIdx = total - clampedOffset;
    const startIdx = Math.max(0, endIdx - Math.min(SCROLLBACK_VIEWPORT_HEIGHT, lineBudget));
    const windowed = blocks.slice(startIdx, endIdx);
    return (
        <>
            <Text dimColor>{`[scroll ${endIdx}/${total} \u2014 PgUp/PgDn to navigate, End to jump to bottom]`}</Text>
            {windowed.map((block, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                <MessageBlock key={`msg-${block.kind}-${startIdx + index}`} block={block} />
            ))}
        </>
    );
}

// Rendered outside core.outputText so it cannot accumulate as ghost text when
// the scrollback grows past the terminal viewport (root cause of the stacking
// bug). Provider/model/session info mirrors StatusBar props.
function Banner({ statusBarProps }: { readonly statusBarProps?: InkChatBridgeOptions }): React.ReactElement {
    if (statusBarProps === undefined) {
        return <Text bold>{'mission-control chat'}</Text>;
    }
    const selection = formatSelectionLabel(statusBarProps);
    return (
        <Box flexDirection="column">
            <Text bold>{'mission-control chat'}</Text>
            <Text dimColor>{selection}</Text>
        </Box>
    );
}

function formatSelectionLabel(props: InkChatBridgeOptions): string {
    const parts = [`provider: ${props.providerID}`, `model: ${props.modelID}`];
    if (props.variantID !== undefined) {
        parts.push(`variant: ${props.variantID}`);
    }
    if (props.sessionID !== undefined) {
        parts.push(`session: ${props.sessionID}`);
    }
    return parts.join(' | ');
}
