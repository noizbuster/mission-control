/** @jsxImportSource @opentui/react */

import type { KeyEvent, PasteEvent, ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import type * as React from 'react';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ChatStore } from '../commands/chat-store.js';
import {
    isSlashCommandMenuOpen,
    isWorkflowCommandMenuOpen,
    resolveSlashCommandMenuInsertText,
    resolveSlashCommandMenuSubmission,
    resolveWorkflowCommandMenuInsertText,
    resolveWorkflowCommandMenuSubmission,
} from '../commands/interactive-chat-command-menu.js';
import { buildFileAutocompleteCompletion } from '../commands/interactive-chat-file-autocomplete.js';
import {
    clipboardImageControls,
    editorControls,
    NO_EDITOR_MESSAGE,
    SUSPEND_UNSUPPORTED_MESSAGE,
    suspendControls,
} from '../commands/terminal-controls.js';
import { evaluatePaste, makeMarker } from '../platform/keymap/bracketed-paste.js';
import { collectDiffEntries } from '../platform/keymap/diff-viewer.js';
import { ChatInputTextarea } from './ChatInputTextarea.js';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DOUBLE_ESC_WINDOW_MS = 500;
const DOUBLE_ESC_ACTION_ENV = 'MCTRL_DOUBLE_ESC_ACTION';

function resolveDoubleEscAction(): 'tree' | 'fork' | 'interrupt' | 'none' {
    const action = process.env[DOUBLE_ESC_ACTION_ENV];
    if (action === 'tree') return 'tree';
    if (action === 'fork') return 'fork';
    if (action === 'none') return 'none';
    return 'interrupt';
}

export type ChatInputAreaProps = {
    readonly store: ChatStore;
    readonly textareaRef: React.RefObject<TextareaRenderable | null>;
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly focused: boolean;
};

export function ChatInputArea({ store, textareaRef, scrollboxRef, focused }: ChatInputAreaProps): React.ReactNode {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);
    const submittingRef = useRef(false);
    const lastEscRef = useRef<number | undefined>(undefined);

    const plainText = (): string => textareaRef.current?.plainText ?? snapshot.inputMirror;

    const applyFileCompletion = (): boolean => {
        const snap = store.getSnapshot();
        const completed = buildFileAutocompleteCompletion(snap.fileAutocomplete);
        const textarea = textareaRef.current;
        if (completed === undefined || textarea === null) return false;
        const text = textarea.plainText;
        const atSuffix = `@${snap.fileAutocomplete.prefix}`;
        if (!text.endsWith(atSuffix)) return false;
        const before = text.slice(0, text.length - atSuffix.length);
        const next = `${before}@${completed}`;
        textarea.setText(next);
        textarea.gotoBufferEnd();
        store.setInputMirror(next);
        return true;
    };

    const handleSubmit = (): void => {
        const captured = textareaRef.current?.plainText ?? '';
        if (submittingRef.current) return;
        submittingRef.current = true;
        setTimeout(() => {
            setTimeout(() => {
                try {
                    if (captured.trim() === '') return;

                    const snap = store.getSnapshot();

                    if (snap.fileAutocomplete.open && applyFileCompletion()) {
                        return;
                    }

                    if (captured.startsWith('#')) {
                        const insertText = resolveWorkflowCommandMenuInsertText(
                            captured,
                            snap.menuState,
                            snap.workflowNames,
                        );
                        if (insertText !== undefined) {
                            textareaRef.current?.setText(insertText);
                            textareaRef.current?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    if (captured.startsWith('/')) {
                        const insertText = resolveSlashCommandMenuInsertText(captured, snap.menuState);
                        if (insertText !== undefined && insertText.trimEnd() !== captured.trimEnd()) {
                            textareaRef.current?.setText(insertText);
                            textareaRef.current?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    let value = snap.pasteStore.expand(captured);

                    if (captured.startsWith('/')) {
                        const resolved = resolveSlashCommandMenuSubmission(captured, snap.menuState);
                        if (resolved !== captured) value = resolved;
                    } else if (captured.startsWith('#')) {
                        const resolved = resolveWorkflowCommandMenuSubmission(
                            captured,
                            snap.menuState,
                            snap.workflowNames,
                        );
                        if (resolved !== captured) value = resolved;
                    }

                    if (value === '/diff') {
                        store.openDiffViewer(collectDiffEntries(store.getOutput()));
                        textareaRef.current?.clear();
                        return;
                    }

                    store.submitLine(value);
                    textareaRef.current?.clear();
                } finally {
                    submittingRef.current = false;
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

        if (key.name === 'tab' && snap.fileAutocomplete.open) {
            key.preventDefault();
            applyFileCompletion();
            return;
        }

        if (key.name === 'escape') {
            key.preventDefault();
            if (snap.generating) {
                lastEscRef.current = undefined;
                store.sendInterrupt('esc');
                return;
            }
            if (snap.fileAutocomplete.open) {
                store.closeMenus();
                return;
            }
            const text = plainText();
            if (text.length > 0) {
                textareaRef.current?.clear();
                store.setInputMirror('');
                return;
            }
            const now = Date.now();
            const action = resolveDoubleEscAction();
            if (action === 'none') return;
            if (lastEscRef.current !== undefined && now - lastEscRef.current < DOUBLE_ESC_WINDOW_MS) {
                lastEscRef.current = undefined;
                if (action === 'tree') {
                    store.sendSlashCommand('/tree');
                } else if (action === 'fork') {
                    store.sendSlashCommand('/fork');
                } else {
                    store.sendInterrupt('esc');
                }
                return;
            }
            lastEscRef.current = now;
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
                if (suspendControls.isWindowsPlatform()) {
                    store.emitOutput(SUSPEND_UNSUPPORTED_MESSAGE);
                } else {
                    suspendControls.sendSuspendSignal();
                }
                return;
            }
            if (key.name === 'd') {
                key.preventDefault();
                if (plainText().length === 0) {
                    store.sendInterrupt('ctrl-c');
                } else {
                    textareaRef.current?.deleteChar();
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
                const editor = editorControls.resolveEditor();
                if (editor === undefined) {
                    store.emitOutput(NO_EDITOR_MESSAGE);
                    return;
                }
                const tempPath = join(tmpdir(), `mctrl-edit-${Date.now()}.md`);
                writeFileSync(tempPath, plainText(), 'utf-8');
                try {
                    editorControls.runEditor(editor, tempPath);
                    const edited = readFileSync(tempPath, 'utf-8');
                    textareaRef.current?.setText(edited);
                    textareaRef.current?.gotoBufferEnd();
                    store.setInputMirror(edited);
                } finally {
                    unlinkSync(tempPath);
                }
                return;
            }
            if (key.name === 'r') {
                key.preventDefault();
                store.showRename();
                return;
            }
            if (key.name === 'v') {
                key.preventDefault();
                const result = clipboardImageControls.readClipboardImage();
                if (result === undefined) return;
                textareaRef.current?.insertText(`${result.path} `);
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
            const historyOwnsArrows = snapshot.historyNavigation !== null;
            const slashMenuOpen = isSlashCommandMenuOpen(buffer);
            const workflowMenuOpen = isWorkflowCommandMenuOpen(buffer);
            const fileAutoOpen = snap.fileAutocomplete.open;

            const recallHistory =
                historyOwnsArrows || (atBound && !slashMenuOpen && !workflowMenuOpen && !fileAutoOpen);
            if (recallHistory) {
                key.preventDefault();
                const recalled = store.recallHistory(direction, buffer);
                textareaRef.current?.setText(recalled);
                textareaRef.current?.gotoBufferEnd();
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
        textareaRef.current?.insertText(makeMarker(id, decision.lineCount, decision.charCount));
    };

    return (
        <box flexDirection="column">
            <ChatInputTextarea
                textareaRef={textareaRef}
                focused={focused}
                onSubmit={handleSubmit}
                onContentChange={handleContentChange}
                onCursorChange={() => {}}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                    snapshot.generating
                        ? 'Press Esc to stop, or wait for the response\u2026'
                        : 'Type a message, / for commands, # for workflows, or Ctrl+C twice to exit'
                }
            />
        </box>
    );
}
