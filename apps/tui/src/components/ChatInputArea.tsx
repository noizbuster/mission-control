/** @jsxImportSource @opentui/solid */

import type { KeyEvent, PasteEvent } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import type { JSX } from 'solid-js';
import { evaluatePaste, makeMarker } from '../platform/keymap/bracketed-paste.js';
import { collectDiffEntries } from '../platform/keymap/diff-viewer.js';
import { halfPageScrollDelta } from '../platform/keymap/messages-scroll.js';
import { useTuiPromptRef } from '../platform/providers/index.js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector.js';
import type { ChatAppActions } from '../state/chat-app-actions.js';
import type { ChatStore, ChatStoreState } from '../state/chat-store.js';
import {
    isSlashCommandMenuOpen,
    isWorkflowCommandMenuOpen,
    resolveSlashCommandMenuInsertText,
    resolveSlashCommandMenuSubmission,
    resolveWorkflowCommandMenuInsertText,
    resolveWorkflowCommandMenuSubmission,
} from '../state/interactive-chat-command-menu.js';
import { buildFileAutocompleteCompletion } from '../state/interactive-chat-file-autocomplete.js';
import { ChatInputTextarea, type ChatTextareaHandle } from './ChatInputTextarea.js';
import type { ChatScrollboxHandle } from './ChatTranscript.js';

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

export function ChatInputArea({
    store,
    textareaRef,
    scrollboxRef,
    focused,
    viewportRows,
    promptMenuInteractionsEnabled = true,
    actions,
}: ChatInputAreaProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, selectInputAreaSlice);
    const promptRef = useTuiPromptRef();
    let submitting = false;
    let lastEsc: number | undefined;

    const plainText = (): string => textareaRef.get()?.plainText ?? snapshot().inputMirror;

    const applyFileCompletion = (): boolean => {
        const snap = store.getSnapshot();
        const completed = buildFileAutocompleteCompletion(snap.fileAutocomplete);
        const textarea = textareaRef.get();
        if (completed === undefined || textarea === undefined) return false;
        const text = textarea.plainText;
        const atSuffix = `@${snap.fileAutocomplete.prefix}`;
        if (!text.endsWith(atSuffix)) return false;
        const before = text.slice(0, text.length - atSuffix.length);
        const next = `${before}@${completed}`;
        textarea.setText(next);
        textarea.gotoBufferEnd();
        store.setInputMirror(next);
        void promptRef.recordFileReference(fileCompletionFrecencyKey(completed));
        return true;
    };

    const handleSubmit = (): void => {
        const captured = textareaRef.get()?.plainText ?? '';
        if (submitting) return;
        submitting = true;
        setTimeout(() => {
            setTimeout(() => {
                try {
                    if (captured.trim() === '') return;

                    const snap = store.getSnapshot();

                    if (promptMenuInteractionsEnabled && snap.fileAutocomplete.open && applyFileCompletion()) {
                        return;
                    }

                    if (promptMenuInteractionsEnabled && captured.startsWith('#')) {
                        const insertText = resolveWorkflowCommandMenuInsertText(
                            captured,
                            snap.menuState,
                            snap.workflowNames,
                        );
                        if (insertText !== undefined) {
                            textareaRef.get()?.setText(insertText);
                            textareaRef.get()?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    if (promptMenuInteractionsEnabled && captured.startsWith('/')) {
                        const insertText = resolveSlashCommandMenuInsertText(captured, snap.menuState);
                        if (insertText !== undefined && insertText.trimEnd() !== captured.trimEnd()) {
                            textareaRef.get()?.setText(insertText);
                            textareaRef.get()?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    let value = snap.pasteStore.expand(captured);

                    if (promptMenuInteractionsEnabled && captured.startsWith('/')) {
                        const resolved = resolveSlashCommandMenuSubmission(captured, snap.menuState);
                        if (resolved !== captured) value = resolved;
                    } else if (promptMenuInteractionsEnabled && captured.startsWith('#')) {
                        const resolved = resolveWorkflowCommandMenuSubmission(
                            captured,
                            snap.menuState,
                            snap.workflowNames,
                        );
                        if (resolved !== captured) value = resolved;
                    }

                    if (value === '/diff') {
                        store.openDiffViewer(collectDiffEntries(store.getOutput()));
                        textareaRef.get()?.clear();
                        return;
                    }

                    store.submitLine(value);
                    textareaRef.get()?.clear();
                } finally {
                    submitting = false;
                }
            }, 0);
        }, 0);
    };

    const handleContentChange = (text: string): void => {
        store.setInputMirror(text);
    };

    const handleKeyDown = (key: KeyEvent): void => {
        if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
            key.preventDefault();
            handleSubmit();
            return;
        }

        const snap = store.getSnapshot();

        if (promptMenuInteractionsEnabled && key.name === 'tab' && snap.fileAutocomplete.open) {
            key.preventDefault();
            applyFileCompletion();
            return;
        }

        if (key.name === 'escape') {
            key.preventDefault();
            if (snap.generating) {
                lastEsc = undefined;
                store.sendInterrupt('esc');
                return;
            }
            if (promptMenuInteractionsEnabled && snap.fileAutocomplete.open) {
                store.closeMenus();
                return;
            }
            const text = plainText();
            if (text.length > 0) {
                textareaRef.get()?.clear();
                store.setInputMirror('');
                return;
            }
            const now = Date.now();
            const action = resolveDoubleEscAction();
            if (action === 'none') return;
            if (lastEsc !== undefined && now - lastEsc < DOUBLE_ESC_WINDOW_MS) {
                lastEsc = undefined;
                if (action === 'tree') {
                    store.sendSlashCommand('/tree');
                } else if (action === 'fork') {
                    store.sendSlashCommand('/fork');
                } else {
                    store.sendInterrupt('esc');
                }
                return;
            }
            lastEsc = now;
            return;
        }

        if (key.ctrl) {
            if (key.name === 'g') {
                key.preventDefault();
                store.toggleAbgOverlay();
                return;
            }
            if (key.name === 'z') {
                key.preventDefault();
                const result = actions?.suspendTerminal?.();
                if (result === undefined) {
                    store.emitOutput(SUSPEND_ACTION_UNAVAILABLE_MESSAGE);
                    return;
                }
                switch (result.kind) {
                    case 'suspended':
                        return;
                    case 'unsupported':
                        store.emitOutput(result.message);
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
                    store.sendInterrupt('ctrl-c');
                } else {
                    textareaRef.get()?.deleteChar();
                }
                return;
            }
            if (key.name === 't') {
                key.preventDefault();
                store.toggleShowThinking();
                return;
            }
            if (key.name === 'o') {
                key.preventDefault();
                store.toggleToolOutputExpanded();
                return;
            }
            if (key.name === 'p') {
                key.preventDefault();
                store.cycleModel(key.shift ? -1 : 1);
                return;
            }
            if (key.name === 'e') {
                key.preventDefault();
                if (actions?.openExternalEditor === undefined) {
                    store.emitOutput(NO_EDITOR_ACTION_MESSAGE);
                    return;
                }
                void actions.openExternalEditor(plainText()).then((result) => {
                    switch (result.kind) {
                        case 'updated':
                            textareaRef.get()?.setText(result.text);
                            textareaRef.get()?.gotoBufferEnd();
                            store.setInputMirror(result.text);
                            return;
                        case 'unavailable':
                        case 'failed':
                            store.emitOutput(result.message);
                            return;
                        default: {
                            const exhaustive: never = result;
                            return exhaustive;
                        }
                    }
                });
                return;
            }
            if (key.name === 'r') {
                key.preventDefault();
                store.showRename();
                return;
            }
            if (key.name === 'v') {
                key.preventDefault();
                store.cycleModelVariant(key.shift ? -1 : 1);
                return;
            }
        }

        if (key.name === 'home') {
            key.preventDefault();
            scrollboxRef.get()?.scrollTo(0);
            return;
        }
        if (key.name === 'end') {
            key.preventDefault();
            const scrollHeight = scrollboxRef.get()?.scrollHeight ?? 0;
            scrollboxRef.get()?.scrollTo(scrollHeight);
            return;
        }
        if (key.name === 'pageup') {
            key.preventDefault();
            const half = halfPageScrollDelta(viewportRows);
            scrollboxRef.get()?.scrollBy(-half);
            return;
        }
        if (key.name === 'pagedown') {
            key.preventDefault();
            const half = halfPageScrollDelta(viewportRows);
            scrollboxRef.get()?.scrollBy(half);
            return;
        }

        if (key.name === 'up' || key.name === 'down') {
            const direction: 'up' | 'down' = key.name;
            const buffer = plainText();
            const cursorOffset = textareaRef.get()?.cursorOffset ?? 0;
            const atBound = direction === 'up' ? cursorOffset === 0 : cursorOffset === buffer.length;
            const historyOwnsArrows = snap.historyNavigation !== null;
            const slashMenuOpen = promptMenuInteractionsEnabled && isSlashCommandMenuOpen(buffer);
            const workflowMenuOpen = promptMenuInteractionsEnabled && isWorkflowCommandMenuOpen(buffer);
            const fileAutoOpen = promptMenuInteractionsEnabled && snap.fileAutocomplete.open;

            const recallHistory =
                historyOwnsArrows || (atBound && !slashMenuOpen && !workflowMenuOpen && !fileAutoOpen);
            if (recallHistory) {
                key.preventDefault();
                const recalled = store.recallHistory(direction, buffer);
                textareaRef.get()?.setText(recalled);
                textareaRef.get()?.gotoBufferEnd();
                return;
            }

            if (slashMenuOpen) {
                key.preventDefault();
                store.navigateSlashMenu(direction);
                return;
            }
            if (workflowMenuOpen) {
                key.preventDefault();
                store.navigateWorkflowMenu(direction);
                return;
            }
            if (fileAutoOpen) {
                key.preventDefault();
                store.navigateFileAutocomplete(direction);
                return;
            }
        }
    };

    const handlePaste = (event: PasteEvent): void => {
        const text = decodePasteBytes(event.bytes);
        const decision = evaluatePaste(text);
        if (decision.kind === 'literal') return;
        event.preventDefault();
        const id = store.registerPaste(text);
        textareaRef.get()?.insertText(makeMarker(id, decision.lineCount, decision.charCount));
    };

    return (
        <box flexDirection="column" flexShrink={0}>
            <ChatInputTextarea
                textareaRef={textareaRef}
                focused={focused}
                onSubmit={handleSubmit}
                onContentChange={handleContentChange}
                onCursorChange={noopCursorChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                    snapshot().generating
                        ? 'Press Esc to stop, or wait for the response\u2026'
                        : 'Type a message, / for commands, # for workflows, or Ctrl+C twice to exit'
                }
            />
        </box>
    );
}
