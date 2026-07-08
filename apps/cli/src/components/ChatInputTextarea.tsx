/** @jsxImportSource @opentui/react */

import type { KeyEvent, PasteEvent, TextareaRenderable } from '@opentui/core';
import { defaultTextareaKeyBindings } from '@opentui/core';
import type * as React from 'react';
import { memo } from 'react';

export type ChatInputTextareaProps = {
    readonly placeholder?: string;
    readonly disabled?: boolean;
    readonly onSubmit: () => void;
    readonly onContentChange: (text: string) => void;
    readonly onCursorChange: () => void;
    readonly onKeyDown: (key: KeyEvent) => void;
    readonly onPaste: (event: PasteEvent) => void;
    readonly textareaRef: React.RefObject<TextareaRenderable | null>;
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
}: ChatInputTextareaProps): React.ReactNode {
    const handleContentChange = (): void => {
        const text = textareaRef.current?.plainText ?? '';
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
                ref={textareaRef}
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

/**
 * Memoized wrapper: skips re-render when all props are unchanged (shallow
 * compare). Effective because ChatInputArea passes stable handler refs
 * (`useCallback`) and a stable selector slice, so streaming tokens no longer
 * re-render the input textarea.
 */
export const ChatInputTextarea = memo(ChatInputTextareaBase);
