/** @jsxImportSource @opentui/solid */

import type { KeyEvent, PasteEvent, TextareaRenderable } from '@opentui/core';
import { defaultTextareaKeyBindings } from '@opentui/core';
import type { JSX } from 'solid-js';

export interface ChatTextareaHandle {
    readonly get: () => ChatTextareaSurface | undefined;
    readonly set: (renderable: TextareaRenderable) => void;
}

export interface ChatTextareaSurface {
    readonly plainText: string;
    cursorOffset: number;
    readonly focused: boolean;
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

export function ChatInputTextareaBase({
    placeholder,
    disabled = false,
    onSubmit,
    onContentChange,
    onCursorChange,
    onKeyDown,
    onPaste,
    textareaRef,
    focused,
}: ChatInputTextareaProps): JSX.Element {
    const handleContentChange = (): void => {
        const text = textareaRef.get()?.plainText ?? '';
        onContentChange(text);
    };

    const handleKeyDown = (key: KeyEvent): void => {
        if (disabled) {
            key.preventDefault();
            return;
        }
        onKeyDown(key);
    };

    const cursorColor = disabled ? '#333333' : '#ffffff';

    return (
        <box backgroundColor="#0a0a0a" border={['left', 'right']} borderColor="#00ffff" flexGrow={1} width="100%">
            <textarea
                ref={(renderable: TextareaRenderable) => textareaRef.set(renderable)}
                width="100%"
                focused={focused}
                placeholderColor="#666666"
                textColor="#ffffff"
                focusedBackgroundColor="#0a0a0a"
                cursorColor={cursorColor}
                onContentChange={handleContentChange}
                onCursorChange={onCursorChange}
                onKeyDown={handleKeyDown}
                onSubmit={onSubmit}
                onPaste={onPaste}
                keyBindings={[
                    ...defaultTextareaKeyBindings,
                    { name: 'return', shift: true, action: 'newline' },
                    { name: 'return', action: 'submit' },
                    { name: 'kpenter', action: 'submit' },
                ]}
                {...(placeholder !== undefined ? { placeholder } : {})}
            />
        </box>
    );
}

export const ChatInputTextarea = ChatInputTextareaBase;
