/**
 * Test-only seam for driving the opentui chat bridge headlessly.
 *
 * After todos 4-7, the textarea (opentui `EditBuffer`) owns all text/cursor
 * editing and the bridge's `bridgeTextareaKeyDown`/`bridgeSubmit`/
 * `bridgeContentChange` own the NON-editing surface (scroll, history recall,
 * overlay toggles, autocomplete completion, submit). `handleInput` is now
 * overlay-only (+ Ctrl+C). These helpers let unit tests drive that surviving
 * surface WITHOUT mounting a real opentui tree and WITHOUT touching
 * `core.inputBuffer`/`core.cursorPosition` as the editing source of truth
 * (the textarea owns those).
 *
 * Test seam:
 *   - `TextareaLike` is the structural port the bridge reads off the textarea
 *     ref (`plainText`, `cursorOffset`, `insertText`, `setText`, `clear`,
 *     `gotoBufferEnd`, `submit`). The recording fake also implements
 *     `deleteChar` (used by the Ctrl+D branch) and mirrors state so successive
 *     reads stay consistent.
 *   - `makeKeyEvent` returns a REAL `KeyEvent` instance (no casts) so
 *     `key.preventDefault()` / `key.defaultPrevented` behave exactly as in the
 *     runtime. The bridge only reads `name`/`ctrl`/`meta`/`shift`/`preventDefault`.
 *   - `createRecordingScrollbox` records `scrollTo`/`scrollBy`/`scrollHeight`.
 *
 * Ref wiring uses the sanctioned null-first concrete-target cast pattern
 * (`as RefObject<T|null>` then `(ref as {current: ...|null}).current = fake`);
 * the fake is cast `as TextareaRenderable`/`as ScrollBoxRenderable` (concrete
 * targets with substantial structural overlap — NOT `as any`/`as unknown`).
 */

import type { KeyEvent, ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { KeyEvent as KeyEventClass } from '@opentui/core';
import type * as React from 'react';

/**
 * The textarea port the bridge depends on. Mirrors the opentui
 * `EditBufferRenderable` surface actually read by `bridgeTextareaKeyDown` /
 * `bridgeSubmit` / `applyFileAutocompleteCompletion`.
 */
export interface TextareaLike {
    plainText: string;
    cursorOffset: number;
    insertText(text: string): void;
    setText(text: string): void;
    clear(): void;
    gotoBufferEnd(): void;
    submit(): void;
}

export type TextareaCall = { readonly method: string; readonly args: readonly unknown[] };

/**
 * Recording fake satisfying `TextareaLike`. `plainText`/`cursorOffset` are
 * mirrored so the bridge's optional-chained reads stay consistent across a
 * sequence of calls. All mutations are also logged to `calls` (plus shaped
 * convenience arrays) so tests assert on what the bridge asked the textarea to
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
 * Wrap a recording textarea fake in a `RefObject<TextareaRenderable | null>`.
 * Casts the ref to a minimal structural shape and assigns the fake directly
 * (the sanctioned ChatInputTextarea.test.tsx idiom) — the fake is never cast to
 * `TextareaRenderable` (insufficient overlap) nor through `unknown`.
 */
export function asTextareaRef(fake: RecordingTextarea): React.RefObject<TextareaRenderable | null> {
    const ref = { current: null } as React.RefObject<TextareaRenderable | null>;
    (ref as { current: RecordingTextarea | null }).current = fake;
    return ref;
}

/**
 * Wrap a recording scrollbox fake in a `RefObject<ScrollBoxRenderable | null>`.
 */
export function asScrollboxRef(fake: RecordingScrollbox): React.RefObject<ScrollBoxRenderable | null> {
    const ref = { current: null } as React.RefObject<ScrollBoxRenderable | null>;
    (ref as { current: RecordingScrollbox | null }).current = fake;
    return ref;
}
