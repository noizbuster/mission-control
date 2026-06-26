/**
 * Test seam: Ctrl+O (tool output expand/collapse toggle) lives in the exported
 * `bridgeTextareaKeyDown`. Drives the toggle via a fake Ctrl+O KeyEvent and
 * asserts `core.toolOutputExpanded` / snapshot / event queue.
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

describe('opentui bridge Ctrl+O tool output expand/collapse toggle via bridgeTextareaKeyDown', () => {
    it('initializes toolOutputExpanded to false', () => {
        const core = createOpenTuiChatBridgeCore();

        expect(core.toolOutputExpanded).toBe(false);
        expect(core.snapshot.toolOutputExpanded).toBe(false);
    });

    it('toggles toolOutputExpanded to true on Ctrl+O', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('o', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.toolOutputExpanded).toBe(true);
    });

    it('toggles toolOutputExpanded back to false on a second Ctrl+O', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('o', { ctrl: true }), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('o', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.toolOutputExpanded).toBe(false);
    });

    it('publishes the new toolOutputExpanded value through the snapshot', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('o', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.snapshot.toolOutputExpanded).toBe(true);
    });

    it('does not enqueue an event on Ctrl+O', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('o', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('calls preventDefault on the Ctrl+O KeyEvent', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        const key = makeKeyEvent('o', { ctrl: true });

        bridgeTextareaKeyDown(core, key, textareaRef, scrollboxRef);

        expect(key.defaultPrevented).toBe(true);
    });

    it('is a no-op on toolOutputExpanded for a plain o (no ctrl) — raw typing is native textarea behavior', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('o'), textareaRef, scrollboxRef);

        expect(core.toolOutputExpanded).toBe(false);
        expect(core.eventQueue.shift()).toBeUndefined();
    });
});
