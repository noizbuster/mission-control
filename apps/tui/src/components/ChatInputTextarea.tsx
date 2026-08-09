/** @jsxImportSource @opentui/solid */

import type { KeyEvent, PasteEvent, TextareaRenderable } from '@opentui/core';
import { defaultTextareaKeyBindings } from '@opentui/core';
import { createEffect, type Accessor, type JSX, onCleanup } from 'solid-js';
import { CHAT_ELEMENT_BG, CHAT_PLACEHOLDER, CHAT_PRIMARY, CHAT_TEXT } from './chat-theme';
import { LEFT_ACCENT_BORDER } from './overlay-theme';

export interface ChatTextareaHandle {
    readonly get: () => ChatTextareaSurface | undefined;
    readonly set: (renderable: TextareaRenderable) => void;
    readonly clear: () => void;
    /** Bumps on attach/detach so Solid effects can track native ref lifecycle. */
    readonly generation?: Accessor<number>;
}

export interface ChatTextareaSurface {
    readonly plainText: string;
    cursorOffset: number;
    readonly focused: boolean;
    focus(): void;
    blur(): void;
    insertText(text: string): void;
    setText(text: string): void;
    clear(): void;
    gotoBufferEnd(): void;
    deleteChar(): void;
}

export type ChatInputTextareaProps = {
    readonly placeholder?: string;
    readonly disabled?: boolean;
    readonly onSubmit: () => void;
    readonly onContentChange: (text: string) => void;
    readonly onCursorChange: () => void;
    readonly onKeyDown: (key: KeyEvent) => void;
    readonly onPaste: (event: PasteEvent) => void;
    readonly textareaRef: ChatTextareaHandle;
    readonly focused: boolean;
};

/**
 * The textarea can retain native focus after an overlay changes its `focused`
 * prop. Explicitly moving focus prevents its keydown handler from consuming
 * printable overlay search input before the overlay keyboard sink sees it.
 */
export function synchronizeTextareaFocus(
    textarea: Pick<ChatTextareaSurface, 'focus' | 'blur'> | undefined,
    focused: boolean,
): void {
    if (textarea === undefined) return;
    if (focused) {
        textarea.focus();
        return;
    }
    textarea.blur();
}

/**
 * OpenCode-style prompt frame: left `┃` accent only (no right border),
 * dark element fill, padded body. Matches ref/opencode Prompt chrome without
 * the dual left+right cyan frame.
 */
export function ChatInputTextareaBase(props: ChatInputTextareaProps): JSX.Element {
    const handleContentChange = (): void => {
        const text = props.textareaRef.get()?.plainText ?? '';
        props.onContentChange(text);
    };

    const handleKeyDown = (key: KeyEvent): void => {
        if (props.disabled) {
            key.preventDefault();
            return;
        }
        props.onKeyDown(key);
    };

    onCleanup(() => props.textareaRef.clear());

    createEffect(() => {
        synchronizeTextareaFocus(props.textareaRef.get(), props.focused);
    });

    return (
        <box
            width="100%"
            border={['left']}
            borderColor={CHAT_PRIMARY}
            customBorderChars={LEFT_ACCENT_BORDER}
            flexShrink={0}
        >
            <box
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                backgroundColor={CHAT_ELEMENT_BG}
                flexShrink={0}
                flexGrow={1}
                width="100%"
                minHeight={1}
            >
                <textarea
                    ref={(renderable: TextareaRenderable) => props.textareaRef.set(renderable)}
                    width="100%"
                    focused={props.focused}
                    placeholderColor={CHAT_PLACEHOLDER}
                    textColor={CHAT_TEXT}
                    focusedTextColor={CHAT_TEXT}
                    focusedBackgroundColor={CHAT_ELEMENT_BG}
                    cursorColor={props.disabled ? '#333333' : CHAT_TEXT}
                    onContentChange={handleContentChange}
                    onCursorChange={props.onCursorChange}
                    onKeyDown={handleKeyDown}
                    onSubmit={props.onSubmit}
                    onPaste={props.onPaste}
                    keyBindings={[
                        ...defaultTextareaKeyBindings,
                        { name: 'return', shift: true, action: 'newline' },
                        { name: 'return', action: 'submit' },
                        { name: 'kpenter', action: 'submit' },
                    ]}
                    {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
                />
            </box>
        </box>
    );
}

export const ChatInputTextarea = ChatInputTextareaBase;
