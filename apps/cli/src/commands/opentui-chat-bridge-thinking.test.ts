/**
 * Test seam: Ctrl+T (thinking toggle) lives in the exported
 * `bridgeTextareaKeyDown`. The bridge owns `core.showThinking`; raw character
 * input is native textarea behavior (not asserted here). These tests drive
 * `bridgeTextareaKeyDown` with a fake Ctrl+T KeyEvent and assert
 * `core.showThinking` / `core.snapshot.showThinking` / `core.eventQueue`.
 */
import { describe, expect, it } from 'vitest';
import { bridgeTextareaKeyDown, createOpenTuiChatBridgeCore } from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './chat-test-support.js';

function setup() {
    const core = createOpenTuiChatBridgeCore();
    const textareaRef = asTextareaRef(createRecordingTextarea());
    const scrollboxRef = asScrollboxRef(createRecordingScrollbox());
    return { core, textareaRef, scrollboxRef };
}

describe('opentui bridge Ctrl+T thinking toggle via bridgeTextareaKeyDown', () => {
    it('initializes showThinking to true', () => {
        const core = createOpenTuiChatBridgeCore();

        expect(core.showThinking).toBe(true);
        expect(core.snapshot.showThinking).toBe(true);
    });

    it('toggles showThinking to false on Ctrl+T', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('t', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.showThinking).toBe(false);
    });

    it('toggles showThinking back to true on a second Ctrl+T', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('t', { ctrl: true }), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('t', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.showThinking).toBe(true);
    });

    it('publishes the new showThinking value through the snapshot', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('t', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.snapshot.showThinking).toBe(false);
    });

    it('does not enqueue an event on Ctrl+T', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('t', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('calls preventDefault on the Ctrl+T KeyEvent', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        const key = makeKeyEvent('t', { ctrl: true });

        bridgeTextareaKeyDown(core, key, textareaRef, scrollboxRef);

        expect(key.defaultPrevented).toBe(true);
    });

    it('is a no-op on showThinking for a plain t (no ctrl) — raw typing is native textarea behavior', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('t'), textareaRef, scrollboxRef);

        expect(core.showThinking).toBe(true);
        expect(core.eventQueue.shift()).toBeUndefined();
    });
});
