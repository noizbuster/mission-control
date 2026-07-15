/**
 * Test-only seam for driving the opentui chat runtime headlessly.
 *
 * After todos 4-7, the textarea (opentui `EditBuffer`) owns all text/cursor
 * editing and the chat runtime handlers own the NON-editing surface (scroll, history recall,
 * overlay toggles, autocomplete completion, submit). `handleInput` is now
 * overlay-only (+ Ctrl+C). These helpers let unit tests drive that surviving
 * surface WITHOUT mounting a real opentui tree and WITHOUT touching
 * `core.inputBuffer`/`core.cursorPosition` as the editing source of truth
 * (the textarea owns those).
 *
 * Test seam:
 *   - `TextareaLike` is the structural port the runtime reads off the textarea
 *     ref (`plainText`, `cursorOffset`, `focused`, `insertText`, `setText`,
 *     `clear`, `gotoBufferEnd`, `submit`). The recording fake also implements
 *     `deleteChar` (used by the Ctrl+D branch) and mirrors state so successive
 *     reads stay consistent.
 *   - `makeKeyEvent` returns a REAL `KeyEvent` instance (no casts) so
 *     `key.preventDefault()` / `key.defaultPrevented` behave exactly as in the
 *     runtime. The TUI handlers only read `name`/`ctrl`/`meta`/`shift`/`preventDefault`.
 *   - `createRecordingScrollbox` records `scrollTo`/`scrollBy`/`scrollHeight`.
 *
 * Handle wiring returns the same get/set shape production components use; the
 * fakes are concrete-target casts with substantial structural overlap, never
 * untyped assertion escapes.
 */

import type { KeyEvent } from '@opentui/core';
import { KeyEvent as KeyEventClass } from '@opentui/core';
import type { ChatTextareaHandle, ChatTextareaSurface } from './ChatInputTextarea';
import type { ChatScrollboxHandle, ChatScrollboxSurface } from './ChatTranscript';

/**
 * The textarea port the runtime depends on. Mirrors the opentui
 * `EditBufferRenderable` surface actually read by textarea keydown, submit,
 * and file-autocomplete completion handlers.
 */
export type TextareaLike = ChatTextareaSurface & { submit(): void };

export type TextareaCall = { readonly method: string; readonly args: readonly unknown[] };

/**
 * Recording fake satisfying `TextareaLike`. `plainText`/`cursorOffset` are
 * mirrored so the runtime's optional-chained reads stay consistent across a
 * sequence of calls. All mutations are also logged to `calls` (plus shaped
 * convenience arrays) so tests assert on what the runtime asked the textarea to
 * do, not on `core.inputBuffer`.
 */
export type RecordingTextarea = TextareaLike & {
    readonly calls: TextareaCall[];
    readonly insertTextCalls: string[];
    readonly setTextCalls: string[];
    readonly clearCount: number;
    readonly gotoBufferEndCount: number;
    readonly submitCount: number;
    readonly deleteCharCount: number;
    deleteChar(): void;
    type(text: string): void;
};

export function createRecordingTextarea(initial = '', cursorOffset?: number): RecordingTextarea {
    const calls: TextareaCall[] = [];
    const insertTextCalls: string[] = [];
    const setTextCalls: string[] = [];
    let text = initial;
    let cursor = cursorOffset ?? initial.length;
    let clearCount = 0;
    let gotoBufferEndCount = 0;
    let submitCount = 0;
    let deleteCharCount = 0;
    return {
        get plainText(): string {
            return text;
        },
        get cursorOffset(): number {
            return cursor;
        },
        set cursorOffset(value: number) {
            cursor = Math.min(Math.max(0, value), text.length);
        },
        get focused(): boolean {
            return true;
        },
        insertText(t: string): void {
            calls.push({ method: 'insertText', args: [t] });
            insertTextCalls.push(t);
            text = text.slice(0, cursor) + t + text.slice(cursor);
            cursor += t.length;
        },
        setText(t: string): void {
            calls.push({ method: 'setText', args: [t] });
            setTextCalls.push(t);
            text = t;
            cursor = t.length;
        },
        clear(): void {
            calls.push({ method: 'clear', args: [] });
            clearCount += 1;
            text = '';
            cursor = 0;
        },
        gotoBufferEnd(): void {
            calls.push({ method: 'gotoBufferEnd', args: [] });
            gotoBufferEndCount += 1;
            cursor = text.length;
        },
        submit(): void {
            calls.push({ method: 'submit', args: [] });
            submitCount += 1;
        },
        deleteChar(): void {
            calls.push({ method: 'deleteChar', args: [] });
            deleteCharCount += 1;
            if (cursor < text.length) {
                text = text.slice(0, cursor) + text.slice(cursor + 1);
            }
        },
        // Simulates native user typing — mutates the buffer WITHOUT recording
        // into setTextCalls (which track bridge-commanded rewrites only).
        type(t: string): void {
            text = t;
            cursor = t.length;
        },
        get calls(): TextareaCall[] {
            return calls;
        },
        get insertTextCalls(): string[] {
            return insertTextCalls;
        },
        get setTextCalls(): string[] {
            return setTextCalls;
        },
        get clearCount(): number {
            return clearCount;
        },
        get gotoBufferEndCount(): number {
            return gotoBufferEndCount;
        },
        get submitCount(): number {
            return submitCount;
        },
        get deleteCharCount(): number {
            return deleteCharCount;
        },
    };
}

export type RecordingScrollbox = {
    readonly scrollToCalls: number[];
    readonly scrollByCalls: number[];
    readonly scrollTop: number;
    readonly scrollHeight: number;
    scrollTo(target: number | { readonly x?: number; readonly y?: number }): void;
    scrollBy(delta: number | { readonly x?: number; readonly y?: number }): void;
};

export function createRecordingScrollbox(scrollHeight = 100): RecordingScrollbox {
    const scrollToCalls: number[] = [];
    const scrollByCalls: number[] = [];
    const toNumber = (value: number | { readonly x?: number; readonly y?: number }): number =>
        typeof value === 'number' ? value : (value.y ?? 0);
    return {
        scrollToCalls,
        scrollByCalls,
        scrollTop: 0,
        scrollHeight,
        scrollTo(value: number | { readonly x?: number; readonly y?: number }): void {
            scrollToCalls.push(toNumber(value));
        },
        scrollBy(value: number | { readonly x?: number; readonly y?: number }): void {
            scrollByCalls.push(toNumber(value));
        },
    };
}

/**
 * Build a real `KeyEvent` instance (no cast). The bridge reads `name`,
 * `ctrl`, `meta`, `shift`, and calls `preventDefault()`; a real instance makes
 * `defaultPrevented` inspectable.
 */
export function makeKeyEvent(
    name: string,
    mods: { readonly ctrl?: boolean; readonly shift?: boolean; readonly meta?: boolean } = {},
): KeyEvent {
    const printable = name.length === 1;
    return new KeyEventClass({
        name,
        ctrl: mods.ctrl ?? false,
        meta: mods.meta ?? false,
        shift: mods.shift ?? false,
        option: false,
        sequence: printable ? name : '',
        number: false,
        raw: printable ? name : '',
        eventType: 'press',
        source: 'raw',
    });
}

/**
 * Wrap a recording textarea fake in the production handle shape.
 */
export function asTextareaRef(fake: RecordingTextarea): ChatTextareaHandle {
    let current: ChatTextareaSurface | undefined = fake;
    return {
        get: () => current,
        set: (renderable) => {
            current = renderable;
        },
    };
}

/**
 * Wrap a recording scrollbox fake in the production handle shape.
 */
export function asScrollboxRef(fake: RecordingScrollbox): ChatScrollboxHandle {
    let current: ChatScrollboxSurface | undefined = fake;
    return {
        get: () => current,
        set: (renderable) => {
            current = renderable;
        },
    };
}
