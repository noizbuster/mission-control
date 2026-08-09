import type { Accessor } from 'solid-js';
import { collectDiffEntries } from '../platform/keymap/diff-viewer';
import type { ChatTextareaHandle } from '../components/ChatInputTextarea';
import type { ChatStore } from '../state/chat-store';
import { buildFileAutocompleteCompletion } from '../state/interactive-chat-file-autocomplete';
import {
    resolveSkillCommandMenuInsertText,
    resolveSkillCommandMenuSubmission,
    resolveSlashCommandMenuInsertText,
    resolveSlashCommandMenuSubmission,
    resolveWorkflowCommandMenuInsertText,
    resolveWorkflowCommandMenuSubmission,
} from '../state/interactive-chat-command-menu';

export type UseSubmitOptions = {
    readonly store: ChatStore;
    readonly textareaHandle: ChatTextareaHandle;
    readonly promptMenuInteractionsEnabled: Accessor<boolean>;
    /** When false, deferred submit is dropped (palette open, etc.). */
    readonly isSubmitEnabled?: Accessor<boolean>;
};

/**
 * Single App Enter-submit path (keymap `chat.submit` layer).
 * IME-safe double setTimeout(0), re-entrancy guard, overlay/history gates,
 * paste expand, file-autocomplete accept, menu insert, `/diff`, submitLine.
 */
export function useSubmit(options: UseSubmitOptions): () => void {
    const { store, textareaHandle, promptMenuInteractionsEnabled, isSubmitEnabled } = options;
    let submitting = false;

    return (): void => {
        if (submitting) return;
        submitting = true;
        const captured = textareaHandle.get()?.plainText ?? '';
        const sessionAtArm = store.getSnapshot().sessionId;
        setTimeout(() => {
            setTimeout(() => {
                try {
                    if (captured.trim() === '') return;
                    const snap = store.getSnapshot();
                    // The delayed IME-safe submit may outlive terminal teardown.
                    // Guard before menu/history mutations, not only at submitLine.
                    if (store.isEventQueueClosed()) return;
                    if (snap.sessionId !== sessionAtArm) return;
                    if (snap.overlayMode !== 'none') return;
                    // submitLine/openDiff already refuse closed queue; keep early exit cheap.

                    if (snap.historyPicker.open) {
                        const selected = store.confirmHistoryPicker();
                        if (selected !== undefined) {
                            textareaHandle.get()?.setText(selected);
                            textareaHandle.get()?.gotoBufferEnd();
                            store.setInputMirror(selected);
                        }
                        return;
                    }

                    if (promptMenuInteractionsEnabled() && snap.fileAutocomplete.open) {
                        const completed = buildFileAutocompleteCompletion(snap.fileAutocomplete);
                        if (completed !== undefined) {
                            const ta = textareaHandle.get();
                            const text = ta?.plainText ?? captured;
                            const atSuffix = `@${snap.fileAutocomplete.prefix}`;
                            const at = text.lastIndexOf(atSuffix);
                            const next =
                                at >= 0
                                    ? `${text.slice(0, at)}@${completed}${text.slice(at + atSuffix.length)}`
                                    : `${text}${completed}`;
                            ta?.setText(next);
                            ta?.gotoBufferEnd();
                            store.setInputMirror(next);
                            store.closeFileAutocomplete();
                            return;
                        }
                    }

                    if (promptMenuInteractionsEnabled() && captured.startsWith('#')) {
                        const insertText = resolveWorkflowCommandMenuInsertText(
                            captured,
                            snap.menuState,
                            snap.workflowNames,
                        );
                        if (insertText !== undefined) {
                            textareaHandle.get()?.setText(insertText);
                            textareaHandle.get()?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    if (promptMenuInteractionsEnabled() && captured.startsWith('$')) {
                        const insertText = resolveSkillCommandMenuInsertText(
                            captured,
                            snap.menuState,
                            snap.skillEntries,
                        );
                        if (insertText !== undefined) {
                            textareaHandle.get()?.setText(insertText);
                            textareaHandle.get()?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    if (promptMenuInteractionsEnabled() && captured.startsWith('/')) {
                        const insertText = resolveSlashCommandMenuInsertText(captured, snap.menuState);
                        if (insertText !== undefined && insertText.trimEnd() !== captured.trimEnd()) {
                            textareaHandle.get()?.setText(insertText);
                            textareaHandle.get()?.gotoBufferEnd();
                            store.setInputMirror(insertText);
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
                    } else if (promptMenuInteractionsEnabled() && captured.startsWith('$')) {
                        const resolved = resolveSkillCommandMenuSubmission(captured, snap.menuState, snap.skillEntries);
                        if (resolved !== captured) value = resolved;
                    }

                    if (value === '/diff') {
                        const opened = store.openDiffViewer(collectDiffEntries(store.getOutput()));
                        if (!opened) return;
                        textareaHandle.get()?.clear();
                        store.setInputMirror('');
                        return;
                    }

                    const accepted = store.submitLine(value);
                    if (!accepted) return;
                    textareaHandle.get()?.clear();
                    store.setInputMirror('');
                } finally {
                    submitting = false;
                }
            }, 0);
        }, 0);
    };
}
