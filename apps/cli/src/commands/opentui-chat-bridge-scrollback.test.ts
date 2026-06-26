/**
 * Test seam: after todos 4-7 keyboard scroll (Home/End/PgUp/PgDn) lives in the
 * exported `bridgeTextareaKeyDown`, which forwards to `scrollboxRef.current`
 * (`scrollTo`/`scrollBy`). The removed `core.scrollOffset` field no longer
 * exists. These tests drive `bridgeTextareaKeyDown` with a recording scrollbox
 * ref and assert the recorded `scrollTo`/`scrollBy` calls — NOT `core.scrollOffset`.
 */
import type { ScrollBoxRenderable } from '@opentui/core';
import type { RefObject } from 'react';
import { describe, expect, it } from 'vitest';
import { bridgeTextareaKeyDown, createOpenTuiChatBridgeCore } from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './chat-test-support.js';

const halfPage = (): number => Math.floor((process.stdout.rows ?? 24) / 2);

describe('opentui bridge Home/End/PgUp/PgDn scrollback via bridgeTextareaKeyDown', () => {
    it('scrolls the scrollbox to the top (0) on Home', () => {
        const core = createOpenTuiChatBridgeCore();
        const scrollbox = createRecordingScrollbox(100);

        bridgeTextareaKeyDown(core, makeKeyEvent('home'), asTextareaRef(createRecordingTextarea()), asScrollboxRef(scrollbox));

        expect(scrollbox.scrollToCalls).toEqual([0]);
    });

    it('scrolls the scrollbox to scrollHeight on End', () => {
        const core = createOpenTuiChatBridgeCore();
        const scrollbox = createRecordingScrollbox(240);

        bridgeTextareaKeyDown(core, makeKeyEvent('end'), asTextareaRef(createRecordingTextarea()), asScrollboxRef(scrollbox));

        expect(scrollbox.scrollToCalls).toEqual([240]);
    });

    it('scrolls backward by half a page on PgUp', () => {
        const core = createOpenTuiChatBridgeCore();
        const scrollbox = createRecordingScrollbox();

        bridgeTextareaKeyDown(core, makeKeyEvent('pageup'), asTextareaRef(createRecordingTextarea()), asScrollboxRef(scrollbox));

        expect(scrollbox.scrollByCalls).toEqual([-halfPage()]);
    });

    it('scrolls forward by half a page on PgDn', () => {
        const core = createOpenTuiChatBridgeCore();
        const scrollbox = createRecordingScrollbox();

        bridgeTextareaKeyDown(core, makeKeyEvent('pagedown'), asTextareaRef(createRecordingTextarea()), asScrollboxRef(scrollbox));

        expect(scrollbox.scrollByCalls).toEqual([halfPage()]);
    });

    it('accumulates repeated PgUp/PgDn as separate scrollBy calls', () => {
        const core = createOpenTuiChatBridgeCore();
        const scrollbox = createRecordingScrollbox();
        const textareaRef = asTextareaRef(createRecordingTextarea());
        const scrollboxRef = asScrollboxRef(scrollbox);

        bridgeTextareaKeyDown(core, makeKeyEvent('pageup'), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('pageup'), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('pagedown'), textareaRef, scrollboxRef);

        expect(scrollbox.scrollByCalls).toEqual([-halfPage(), -halfPage(), halfPage()]);
    });

    it('jumping Home then End records both scrollTo calls in order', () => {
        const core = createOpenTuiChatBridgeCore();
        const scrollbox = createRecordingScrollbox(300);
        const textareaRef = asTextareaRef(createRecordingTextarea());
        const scrollboxRef = asScrollboxRef(scrollbox);

        bridgeTextareaKeyDown(core, makeKeyEvent('home'), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('end'), textareaRef, scrollboxRef);

        expect(scrollbox.scrollToCalls).toEqual([0, 300]);
    });

    it('calls preventDefault on the KeyEvent for each scroll key', () => {
        const core = createOpenTuiChatBridgeCore();
        const textareaRef = asTextareaRef(createRecordingTextarea());
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());

        for (const name of ['home', 'end', 'pageup', 'pagedown'] as const) {
            const key = makeKeyEvent(name);
            bridgeTextareaKeyDown(core, key, textareaRef, scrollboxRef);
            expect(key.defaultPrevented).toBe(true);
        }
    });

    it('is a no-op on the scrollbox when the scrollbox ref is unattached (current is null)', () => {
        const core = createOpenTuiChatBridgeCore();
        // Real optional-chained behavior: a null current must not throw.
        const scrollboxRef: RefObject<ScrollBoxRenderable | null> = { current: null };

        expect(() => {
            bridgeTextareaKeyDown(core, makeKeyEvent('pageup'), asTextareaRef(createRecordingTextarea()), scrollboxRef);
        }).not.toThrow();
    });
});
