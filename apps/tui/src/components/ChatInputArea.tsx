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

export function ChatInputArea(props: ChatInputAreaProps): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, selectInputAreaSlice);
    const promptRef = useTuiPromptRef();
    const promptMenuInteractionsEnabled = (): boolean => props.promptMenuInteractionsEnabled ?? true;
    let submitting = false;
    let lastEsc: number | undefined;

    const plainText = (): string => props.textareaRef.get()?.plainText ?? snapshot().inputMirror;

    const applyFileCompletion = (): boolean => {
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
        void promptRef.recordFileReference(fileCompletionFrecencyKey(completed));
        return true;
    };

    const handleSubmit = (): void => {
        const captured = props.textareaRef.get()?.plainText ?? '';
        if (submitting) return;
        submitting = true;
        setTimeout(() => {
            setTimeout(() => {
                try {
                    if (captured.trim() === '') return;

                    const snap = props.store.getSnapshot();

                    if (promptMenuInteractionsEnabled() && snap.fileAutocomplete.open && applyFileCompletion()) {
                        return;
                    }

                    if (promptMenuInteractionsEnabled() && captured.startsWith('#')) {
                        const insertText = resolveWorkflowCommandMenuInsertText(
                            captured,
                            snap.menuState,
                            snap.workflowNames,
                        );
                        if (insertText !== undefined) {
                            props.textareaRef.get()?.setText(insertText);
                            props.textareaRef.get()?.gotoBufferEnd();
                            props.store.setInputMirror(insertText);
                            return;
                        }
                    }

                    if (promptMenuInteractionsEnabled() && captured.startsWith('/')) {
                        const insertText = resolveSlashCommandMenuInsertText(captured, snap.menuState);
                        if (insertText !== undefined && insertText.trimEnd() !== captured.trimEnd()) {
                            props.textareaRef.get()?.setText(insertText);
                            props.textareaRef.get()?.gotoBufferEnd();
                            props.store.setInputMirror(insertText);
                            return;
                        }
                    }

                    let value = snap.pasteStore.expand(captured);

                    if (promptMenuInteractionsEnabled() && captured.startsWith('/')) {
                        const resolved = resolveSlashCommandMenuSubmission(captured, snap.menuState);
                        if (resolved !== captured) value = resolved;
                    } else if (promptMenuInteractionsEnabled() && captured.startsWith('#')) {
                        const resolved = resolveWorkflowCommandMenuSubmission(
                            captured,
                            snap.menuState,
                            snap.workflowNames,
                        );
                        if (resolved !== captured) value = resolved;
                    }

                    if (value === '/diff') {
                        props.store.openDiffViewer(collectDiffEntries(props.store.getOutput()));
                        props.textareaRef.get()?.clear();
                        return;
                    }

                    props.store.submitLine(value);
                    props.textareaRef.get()?.clear();
                } finally {
                    submitting = false;
                }
            }, 0);
        }, 0);
    };

    const handleContentChange = (text: string): void => {
        props.store.setInputMirror(text);
    };

    const handleKeyDown = (key: KeyEvent): void => {
        const snap = props.store.getSnapshot();

        const hostedOverlayActive = snap.overlayMode === 'rename' || snap.overlayMode === 'approval' ||
            snap.overlayMode === 'level-picker' || snap.overlayMode === 'model-picker' ||
            snap.overlayMode === 'session-picker';

        if (hostedOverlayActive) {
            if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right' ||
                key.name === 'pageup' || key.name === 'pagedown' || key.name === 'home' || key.name === 'end' ||
                key.name === 'return' || key.name === 'escape' || key.name === 'backspace' ||
                key.name === 'tab') {
                return;
            }
            const ch = String.fromCodePoint((key as { baseCode?: number }).baseCode ?? 0);
            if (ch.length > 0 && ch.charCodeAt(0) >= 32) {
                key.preventDefault();
                return;
            }
        }

        if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
            key.preventDefault();
            handleSubmit();
            return;
        }

        if (promptMenuInteractionsEnabled() && key.name === 'tab' && snap.fileAutocomplete.open) {
            key.preventDefault();
            applyFileCompletion();
            return;
        }

        if (key.name === 'escape') {
            key.preventDefault();
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
                props.store.toggleAbgOverlay();
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
                void props.actions.openExternalEditor(plainText()).then((result) => {
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

        if (key.name === 'up' || key.name === 'down') {
            const direction: 'up' | 'down' = key.name;
            const buffer = plainText();
            const slashMenuOpen = promptMenuInteractionsEnabled() && isSlashCommandMenuOpen(buffer);
            const workflowMenuOpen = promptMenuInteractionsEnabled() && isWorkflowCommandMenuOpen(buffer);
            const fileAutoOpen = promptMenuInteractionsEnabled() && snap.fileAutocomplete.open;

            if (snap.historyPicker.open) {
                key.preventDefault();
                props.store.navigateHistoryPicker(direction);
                return;
            }

            if (slashMenuOpen) {
                key.preventDefault();
                props.store.navigateSlashMenu(direction);
                return;
            }
            if (workflowMenuOpen) {
                key.preventDefault();
                props.store.navigateWorkflowMenu(direction);
                return;
            }
            if (fileAutoOpen) {
                key.preventDefault();
                props.store.navigateFileAutocomplete(direction);
                return;
            }
        }
    };

    const handlePaste = (event: PasteEvent): void => {
        const text = decodePasteBytes(event.bytes);
        const decision = evaluatePaste(text);
        if (decision.kind === 'literal') return;
        event.preventDefault();
        const id = props.store.registerPaste(text);
        props.textareaRef.get()?.insertText(makeMarker(id, decision.lineCount, decision.charCount));
    };

    return (
        <box flexDirection="column" flexShrink={0}>
            <ChatInputTextarea
                textareaRef={props.textareaRef}
                focused={props.focused}
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
