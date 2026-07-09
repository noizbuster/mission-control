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

    return (
        <box
            backgroundColor="#0a0a0a"
            border={['left', 'right']}
            borderColor="#00ffff"
            flexShrink={0}
            width="100%"
            minHeight={1}
        >
            <textarea
                ref={(renderable: TextareaRenderable) => props.textareaRef.set(renderable)}
                width="100%"
                focused={props.focused}
                placeholderColor="#666666"
                textColor="#ffffff"
                focusedBackgroundColor="#0a0a0a"
                cursorColor={props.disabled ? '#333333' : '#ffffff'}
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
    );
}

export const ChatInputTextarea = ChatInputTextareaBase;
