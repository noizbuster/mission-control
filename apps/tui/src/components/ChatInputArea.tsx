/** @jsxImportSource @opentui/solid */

import { errorToString } from '@mission-control/core';
import type { KeyEvent, PasteEvent } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import { useContext, createEffect, type JSX } from 'solid-js';
import { clampPasteText, evaluatePaste, makeMarker } from '../platform/keymap/bracketed-paste';
import { halfPageScrollDelta } from '../platform/keymap/messages-scroll';
import { useTuiPromptRef } from '../platform/providers/index';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector';
import type { ChatAppActions } from '../state/chat-app-actions';
import type { ChatStore, ChatStoreState } from '../state/chat-store';
import {
    isSkillCommandMenuOpen,
    isSlashCommandMenuOpen,
    isWorkflowCommandMenuOpen,
    resolveSkillCommandMenuInsertText,
    resolveSlashCommandMenuInsertText,
    resolveWorkflowCommandMenuInsertText,
} from '../state/interactive-chat-command-menu';
import { buildFileAutocompleteCompletion } from '../state/interactive-chat-file-autocomplete';
import { PaletteOpenContext } from '../platform/keymap/palette-open-context';
import { ChatInputTextarea, type ChatTextareaHandle } from './ChatInputTextarea';
import type { ChatScrollboxHandle } from './ChatTranscript';
import { applyHistoryRecallText } from './prompt-history-recall';
import { completionPromptListControls, historyPickerPromptListControls } from './prompt-list-controls';

const DOUBLE_ESC_WINDOW_MS = 500;
const DOUBLE_ESC_ACTION_ENV = 'MCTRL_DOUBLE_ESC_ACTION';
const NO_EDITOR_ACTION_MESSAGE = 'No editor set. Set $VISUAL or $EDITOR.\n';
const SUSPEND_ACTION_UNAVAILABLE_MESSAGE = 'Suspend not available in this environment.\n';
const noopCursorChange = (): void => {};

export function fileCompletionFrecencyKey(completed: string): string {
    return completed.endsWith('/') ? completed.slice(0, -1) : completed;
}

function resolveDoubleEscAction(): 'tree' | 'fork' | 'interrupt' | 'none' {
    const action = process.env[DOUBLE_ESC_ACTION_ENV];
    if (action === 'tree') return 'tree';
    if (action === 'fork') return 'fork';
    if (action === 'none') return 'none';
    return 'interrupt';
}

function selectInputAreaSlice(snap: ChatStoreState) {
    return {
        inputMirror: snap.inputMirror,
        generating: snap.generating,
        overlayMode: snap.overlayMode,
        fileAutocomplete: snap.fileAutocomplete,
        menuState: snap.menuState,
    };
}

export type ChatInputAreaProps = {
    readonly store: ChatStore;
    readonly textareaRef: ChatTextareaHandle;
    readonly scrollboxRef: ChatScrollboxHandle;
    readonly focused: boolean;
    readonly viewportRows: number;
    readonly promptMenuInteractionsEnabled?: boolean;
    readonly actions?: ChatAppActions;
};

export function ChatInputArea(props: ChatInputAreaProps): JSX.Element {
    const paletteOpenState = useContext(PaletteOpenContext);
    const snapshot = useSolidStoreSelector(props.store, selectInputAreaSlice);
    const promptRef = useTuiPromptRef();
    const promptMenuInteractionsEnabled = (): boolean => props.promptMenuInteractionsEnabled ?? true;
    let lastEsc: number | undefined;

    const plainText = (): string => props.textareaRef.get()?.plainText ?? snapshot().inputMirror;

    // Keep native textarea aligned with store inputMirror after draft restore,
    // soft remount, session-switch draft load, or stash pop when the native
    // buffer lagged behind the store (store is source of truth for drafts).
    createEffect(() => {
        // Track native attach/detach (soft remount) via optional generation signal.
        props.textareaRef.generation?.();
        const mirror = snapshot().inputMirror;
        const textarea = props.textareaRef.get();
        if (textarea === undefined) return;
        if (textarea.plainText === mirror) return;
        textarea.setText(mirror);
        textarea.gotoBufferEnd();
    });

    const applyFileCompletion = (): boolean => {
        props.store.ensureFileAutocompleteCurrent();
        const snap = props.store.getSnapshot();
        const completed = buildFileAutocompleteCompletion(snap.fileAutocomplete);
        const textarea = props.textareaRef.get();
        if (completed === undefined || textarea === undefined) return false;
        const text = textarea.plainText;
        const atSuffix = `@${snap.fileAutocomplete.prefix}`;
        if (!text.endsWith(atSuffix)) return false;
        const before = text.slice(0, text.length - atSuffix.length);
        const next = `${before}@${completed}`;
        textarea.setText(next);
        textarea.gotoBufferEnd();
        props.store.setInputMirror(next);
        void promptRef.recordFileReference(fileCompletionFrecencyKey(completed)).catch(() => undefined);
        return true;
    };

    const applyCommandMenuCompletion = (insertText: string | undefined): void => {
        if (insertText === undefined) return;
        props.textareaRef.get()?.setText(insertText);
        props.textareaRef.get()?.gotoBufferEnd();
        props.store.setInputMirror(insertText);
    };

    const handleContentChange = (text: string): void => {
        props.store.setInputMirror(text);
    };

    const handleKeyDown = (key: KeyEvent): void => {
        const snap = props.store.getSnapshot();

        // Any non-none overlay owns the keyboard; do not let the prompt
        // textarea also consume Enter/Ctrl chords underneath.
        if (snap.overlayMode !== 'none') {
            key.preventDefault();
            return;
        }
        // Command palette filter owns printables while open (T8 double-handle).
        if (paletteOpenState?.open() === true) {
            key.preventDefault();
            return;
        }
        // History owns the prompt dock; block Ctrl chords (model cycle/editor/etc.)
        // and transcript scroll chords while still allowing Esc/Tab/Enter and Up/Down.
        if (
            snap.historyPicker.open &&
            (key.ctrl || key.name === 'home' || key.name === 'end' || key.name === 'pageup' || key.name === 'pagedown')
        ) {
            key.preventDefault();
            return;
        }

        if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
            // Production Enter (including history confirm) is owned by keymap
            // `chat.submit` → useSubmit. Prevent the native textarea submit path only.
            key.preventDefault();
            return;
        }

        if (
            key.name === 'tab' &&
            historyPickerPromptListControls.acceptKeys.includes('tab') &&
            snap.historyPicker.open
        ) {
            key.preventDefault();
            const selected = props.store.confirmHistoryPicker();
            if (selected !== undefined) {
                applyHistoryRecallText(props.textareaRef.get(), selected, (text) => props.store.setInputMirror(text));
            }
            return;
        }

        if (
            key.name === 'tab' &&
            promptMenuInteractionsEnabled() &&
            completionPromptListControls.acceptKeys.includes('tab') &&
            snap.fileAutocomplete.open
        ) {
            key.preventDefault();
            applyFileCompletion();
            return;
        }

        if (
            key.name === 'tab' &&
            promptMenuInteractionsEnabled() &&
            completionPromptListControls.acceptKeys.includes('tab')
        ) {
            const buffer = plainText();
            if (isWorkflowCommandMenuOpen(buffer)) {
                key.preventDefault();
                applyCommandMenuCompletion(
                    resolveWorkflowCommandMenuInsertText(buffer, snap.menuState, snap.workflowNames),
                );
                return;
            }
            if (isSkillCommandMenuOpen(buffer)) {
                key.preventDefault();
                applyCommandMenuCompletion(
                    resolveSkillCommandMenuInsertText(buffer, snap.menuState, snap.skillEntries),
                );
                return;
            }
            if (isSlashCommandMenuOpen(buffer)) {
                key.preventDefault();
                applyCommandMenuCompletion(resolveSlashCommandMenuInsertText(buffer, snap.menuState));
                return;
            }
        }

        if (key.name === 'escape') {
            key.preventDefault();
            if (snap.historyPicker.open) {
                lastEsc = undefined;
                props.store.cancelHistoryPicker();
                return;
            }
            if (snap.generating) {
                lastEsc = undefined;
                props.store.sendInterrupt('esc');
                return;
            }
            if (promptMenuInteractionsEnabled() && snap.fileAutocomplete.open) {
                props.store.closeMenus();
                return;
            }
            const text = plainText();
            if (text.length > 0) {
                props.textareaRef.get()?.clear();
                props.store.setInputMirror('');
                return;
            }
            const now = Date.now();
            const action = resolveDoubleEscAction();
            if (action === 'none') return;
            if (lastEsc !== undefined && now - lastEsc < DOUBLE_ESC_WINDOW_MS) {
                lastEsc = undefined;
                if (action === 'tree') {
                    props.store.sendSlashCommand('/tree');
                } else if (action === 'fork') {
                    props.store.sendSlashCommand('/fork');
                } else {
                    props.store.sendInterrupt('esc');
                }
                return;
            }
            lastEsc = now;
            return;
        }

        if (key.ctrl) {
            if (key.name === 'g') {
                key.preventDefault();
                try {
                    props.store.toggleAbgOverlay();
                } catch (error: unknown) {
                    const message = errorToString(error);
                    props.store.emitOutput(`Error: ABG overlay toggle failed: ${message}\n`);
                }
                return;
            }
            if (key.name === 'z') {
                key.preventDefault();
                const result = props.actions?.suspendTerminal?.();
                if (result === undefined) {
                    props.store.emitOutput(SUSPEND_ACTION_UNAVAILABLE_MESSAGE);
                    return;
                }
                switch (result.kind) {
                    case 'suspended':
                        return;
                    case 'unsupported':
                        props.store.emitOutput(result.message);
                        return;
                    default: {
                        const exhaustive: never = result;
                        throw new Error(`Unhandled terminal suspend result: ${String(exhaustive)}`);
                    }
                }
            }
            if (key.name === 'd') {
                key.preventDefault();
                if (plainText().length === 0) {
                    props.store.sendInterrupt('ctrl-c');
                } else {
                    props.textareaRef.get()?.deleteChar();
                }
                return;
            }
            if (key.name === 't') {
                key.preventDefault();
                props.store.toggleShowThinking();
                return;
            }
            if (key.name === 'o') {
                key.preventDefault();
                props.store.toggleToolOutputExpanded();
                return;
            }
            if (key.name === 'p') {
                key.preventDefault();
                props.store.cycleModel(key.shift ? -1 : 1);
                return;
            }
            if (key.name === 'e') {
                key.preventDefault();
                if (props.actions?.openExternalEditor === undefined) {
                    props.store.emitOutput(NO_EDITOR_ACTION_MESSAGE);
                    return;
                }
                const sessionAtOpen = props.store.getSnapshot().sessionId;
                void props.actions
                    .openExternalEditor(plainText())
                    .then((result) => {
                        const snap = props.store.getSnapshot();
                        // Drop stale editor results after teardown, session switch, overlay, or palette.
                        if (
                            props.store.isEventQueueClosed() ||
                            snap.overlayMode !== 'none' ||
                            snap.sessionId !== sessionAtOpen ||
                            paletteOpenState?.open() === true ||
                            snap.historyPicker.open
                        ) {
                            return;
                        }
                        // setInputMirror/emitOutput already no-op after close.
                        switch (result.kind) {
                            case 'updated':
                                props.textareaRef.get()?.setText(result.text);
                                props.textareaRef.get()?.gotoBufferEnd();
                                props.store.setInputMirror(result.text);
                                return;
                            case 'unavailable':
                            case 'failed':
                                props.store.emitOutput(result.message);
                                return;
                            default: {
                                const exhaustive: never = result;
                                return exhaustive;
                            }
                        }
                    })
                    .catch((error: unknown) => {
                        const snap = props.store.getSnapshot();
                        if (
                            props.store.isEventQueueClosed() ||
                            snap.overlayMode !== 'none' ||
                            snap.sessionId !== sessionAtOpen ||
                            paletteOpenState?.open() === true ||
                            snap.historyPicker.open
                        ) {
                            return;
                        }
                        props.store.emitOutput(`Error: external editor failed: ${errorToString(error)}\n`);
                    });
                return;
            }
            if (key.name === 'r') {
                key.preventDefault();
                props.store.showRename();
                return;
            }
            if (key.name === 'v') {
                key.preventDefault();
                props.store.cycleModelVariant(key.shift ? -1 : 1);
                return;
            }
        }

        if (key.name === 'home') {
            key.preventDefault();
            props.scrollboxRef.get()?.scrollTo(0);
            return;
        }
        if (key.name === 'end') {
            key.preventDefault();
            const scrollHeight = props.scrollboxRef.get()?.scrollHeight ?? 0;
            props.scrollboxRef.get()?.scrollTo(scrollHeight);
            return;
        }
        if (key.name === 'pageup') {
            key.preventDefault();
            const half = halfPageScrollDelta(props.viewportRows);
            props.scrollboxRef.get()?.scrollBy(-half);
            return;
        }
        if (key.name === 'pagedown') {
            key.preventDefault();
            const half = halfPageScrollDelta(props.viewportRows);
            props.scrollboxRef.get()?.scrollBy(half);
            return;
        }

        // Up/Down menu + history navigation is owned by keymap layers
        // (menu-navigation + prompt-history-recall), not the textarea sink.
    };

    const handlePaste = (event: PasteEvent): void => {
        const snap = props.store.getSnapshot();
        // Decision/view overlays and command palette own the keyboard.
        if (snap.overlayMode !== 'none' || paletteOpenState?.open() === true || snap.historyPicker.open) {
            event.preventDefault();
            return;
        }
        const text = clampPasteText(decodePasteBytes(event.bytes));
        const decision = evaluatePaste(text);
        if (decision.kind === 'literal') return;
        event.preventDefault();
        const id = props.store.registerPaste(text);
        if (id < 0) return;
        props.textareaRef.get()?.insertText(makeMarker(id, decision.lineCount, decision.charCount));
    };

    return (
        <box flexDirection="column" flexShrink={0}>
            <ChatInputTextarea
                textareaRef={props.textareaRef}
                focused={props.focused}
                onSubmit={() => {
                    /* chat.submit keymap owns Enter */
                }}
                onContentChange={handleContentChange}
                onCursorChange={noopCursorChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                    snapshot().generating
                        ? 'Press Esc to stop, or wait for the response\u2026'
                        : 'Type a message, / for commands, # for workflows, $ for skills, or Ctrl+C twice to exit'
                }
            />
        </box>
    );
}
