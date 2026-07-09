import type { Accessor } from 'solid-js';
import type { ChatStore } from '../../state/chat-store.js';
import {
    resolveSlashCommandMenuInsertText,
    resolveWorkflowCommandMenuInsertText,
} from '../../state/interactive-chat-command-menu.js';
import type { ChatTextareaHandle } from '../ChatInputTextarea.js';

export type UseChatSubmitOptions = {
    readonly store: ChatStore;
    readonly textareaHandle: ChatTextareaHandle;
    readonly promptMenuInteractionsEnabled: Accessor<boolean>;
};

/**
 * ChatApp Enter-submit path (keymap chat.submit layer). Preserves IME-safe
 * double setTimeout(0), re-entrancy guard, empty reject, and slash/workflow
 * menu insert-before-submit behavior. Does not expand paste markers or handle
 * file-autocomplete completion (those stay on ChatInputArea).
 */
export function useChatSubmit(options: UseChatSubmitOptions): () => void {
    const { store, textareaHandle, promptMenuInteractionsEnabled } = options;
    let submitting = false;

    return (): void => {
        if (submitting) return;
        submitting = true;
        const captured = textareaHandle.get()?.plainText ?? '';
        setTimeout(() => {
            setTimeout(() => {
                try {
                    if (captured.trim() === '') return;
                    const snap = store.getSnapshot();
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

                    if (promptMenuInteractionsEnabled() && captured.startsWith('/')) {
                        const insertText = resolveSlashCommandMenuInsertText(captured, snap.menuState);
                        if (insertText !== undefined && insertText.trimEnd() !== captured.trimEnd()) {
                            textareaHandle.get()?.setText(insertText);
                            textareaHandle.get()?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    store.submitLine(captured);
                    textareaHandle.get()?.clear();
                } finally {
                    submitting = false;
                }
            }, 0);
        }, 0);
    };
}
