import type { TextareaRenderable } from '@opentui/core';
import type { ReactNode, RefObject } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInputTextarea, type ChatInputTextareaProps } from './ChatInputTextarea.js';

type TextareaPropShape = {
    readonly onContentChange: () => void;
    readonly onKeyDown: (key: { preventDefault(): void }) => void;
    readonly keyBindings: ReadonlyArray<{
        readonly name: string;
        readonly action: string;
        readonly shift?: boolean;
        readonly ctrl?: boolean;
        readonly meta?: boolean;
    }>;
    readonly placeholder?: string;
    readonly cursorColor: string;
};

const noopCallbacks = {
    onSubmit: (): void => {},
    onContentChange: (_text: string): void => {},
    onCursorChange: (): void => {},
    onKeyDown: (_key: { preventDefault(): void }): void => {},
    onPaste: (): void => {},
} as const;

function makeMockRef(plainText: string): RefObject<TextareaRenderable | null> {
    const ref = { current: null } as RefObject<TextareaRenderable | null>;
    (ref as { current: { readonly plainText: string } | null }).current = { plainText };
    return ref;
}

function mountTextarea(props: ChatInputTextareaProps): TextareaPropShape {
    const node: ReactNode = ChatInputTextarea(props);
    if (!isValidElement(node)) {
        throw new Error('ChatInputTextarea did not return a valid element');
    }
    const boxChildren = (node.props as { readonly children?: ReactNode }).children;
    if (!isValidElement(boxChildren)) {
        throw new Error('expected a textarea child inside the box');
    }
    return boxChildren.props as TextareaPropShape;
}

describe('ChatInputTextarea', () => {
    describe('onContentChange', () => {
        it('forwards ref.current.plainText to the parent callback when the textarea content changes', () => {
            const received: string[] = [];
            const ref = makeMockRef('hello world');
            const props = mountTextarea({
                ...noopCallbacks,
                onContentChange: (text) => {
                    received.push(text);
                },
                textareaRef: ref,
                focused: true,
            });

            props.onContentChange();

            expect(received).toEqual(['hello world']);
        });

        it('forwards an empty string when ref.current is null', () => {
            const received: string[] = [];
            const ref = { current: null } as RefObject<TextareaRenderable | null>;
            const props = mountTextarea({
                ...noopCallbacks,
                onContentChange: (text) => {
                    received.push(text);
                },
                textareaRef: ref,
                focused: true,
            });

            props.onContentChange();

            expect(received).toEqual(['']);
        });
    });

    describe('onKeyDown disabled guard', () => {
        it('preventDefaults and does not forward to the parent when disabled', () => {
            const forwarded: Array<{ preventDefault(): void }> = [];
            const fakeKey = { preventDefault: vi.fn() };
            const props = mountTextarea({
                ...noopCallbacks,
                disabled: true,
                onKeyDown: (key) => {
                    forwarded.push(key);
                },
                textareaRef: { current: null } as RefObject<TextareaRenderable | null>,
                focused: true,
            });

            props.onKeyDown(fakeKey);

            expect(fakeKey.preventDefault).toHaveBeenCalledOnce();
            expect(forwarded).toEqual([]);
        });

        it('forwards the key to the parent when not disabled', () => {
            const forwarded: Array<{ preventDefault(): void }> = [];
            const fakeKey = { preventDefault: vi.fn() };
            const props = mountTextarea({
                ...noopCallbacks,
                onKeyDown: (key) => {
                    forwarded.push(key);
                },
                textareaRef: { current: null } as RefObject<TextareaRenderable | null>,
                focused: true,
            });

            props.onKeyDown(fakeKey);

            expect(fakeKey.preventDefault).not.toHaveBeenCalled();
            expect(forwarded).toEqual([fakeKey]);
        });
    });

    describe('cursorColor', () => {
        it('uses the dim cursor color when disabled', () => {
            const props = mountTextarea({
                ...noopCallbacks,
                disabled: true,
                textareaRef: { current: null } as RefObject<TextareaRenderable | null>,
                focused: true,
            });

            expect(props.cursorColor).toBe('#333333');
        });

        it('uses the bright cursor color when enabled', () => {
            const props = mountTextarea({
                ...noopCallbacks,
                textareaRef: { current: null } as RefObject<TextareaRenderable | null>,
                focused: true,
            });

            expect(props.cursorColor).toBe('#ffffff');
        });
    });

    describe('placeholder', () => {
        it('spreads the placeholder prop onto the textarea when provided', () => {
            const props = mountTextarea({
                ...noopCallbacks,
                placeholder: 'type here',
                textareaRef: { current: null } as RefObject<TextareaRenderable | null>,
                focused: true,
            });

            expect(props.placeholder).toBe('type here');
        });

        it('omits the placeholder prop entirely when undefined (exactOptionalPropertyTypes)', () => {
            const node = ChatInputTextarea({
                ...noopCallbacks,
                textareaRef: { current: null } as RefObject<TextareaRenderable | null>,
                focused: true,
            });
            if (!isValidElement(node)) {
                throw new Error('expected a box element');
            }
            const child = (node.props as { readonly children?: ReactNode }).children;
            if (!isValidElement(child)) {
                throw new Error('expected textarea child');
            }
            const childProps = child.props as Record<string, unknown>;

            expect(childProps).not.toHaveProperty('placeholder');
        });
    });

    describe('keyBindings override', () => {
        // keyBindings is `[...defaults, ...custom]` with a last-write-wins
        // composite-key merge, so plain-return/kpenter overrides are the LAST
        // match — look them up with filter().at(-1), not find() (first match).
        const mountBindings = (): TextareaPropShape['keyBindings'] =>
            mountTextarea({
                ...noopCallbacks,
                textareaRef: { current: null } as RefObject<TextareaRenderable | null>,
                focused: true,
            }).keyBindings;

        it('binds plain Enter (return, no modifiers) to submit', () => {
            const bindings = mountBindings();
            const plainReturn = bindings.filter((b) => b.name === 'return' && !b.shift && !b.ctrl && !b.meta).at(-1);
            expect(plainReturn?.action).toBe('submit');
        });

        it('binds Shift+Enter to newline', () => {
            const bindings = mountBindings();
            const shiftReturn = bindings.find((b) => b.name === 'return' && b.shift === true && !b.ctrl && !b.meta);
            expect(shiftReturn?.action).toBe('newline');
        });

        it('binds kpenter (no modifiers) to submit', () => {
            const bindings = mountBindings();
            const plainKpenter = bindings.filter((b) => b.name === 'kpenter' && !b.shift && !b.ctrl && !b.meta).at(-1);
            expect(plainKpenter?.action).toBe('submit');
        });

        it('preserves the default Alt+Enter (meta+return) submit binding (no silent regression)', () => {
            const bindings = mountBindings();
            const metaReturn = bindings.find((b) => b.name === 'return' && b.meta === true && !b.shift && !b.ctrl);
            expect(metaReturn?.action).toBe('submit');
        });

        it('preserves default editing bindings (backspace)', () => {
            const bindings = mountBindings();
            const backspace = bindings.find((b) => b.name === 'backspace' && !b.shift && !b.ctrl && !b.meta);
            expect(backspace?.action).toBe('backspace');
        });
    });
});
