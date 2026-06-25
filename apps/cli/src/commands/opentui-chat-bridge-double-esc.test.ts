/**
 * Test seam: idle Esc (double-Esc action, buffer-clear, generating-interrupt)
 * moved to the exported `bridgeTextareaKeyDown`; overlay-mode Esc (model
 * picker, rename) still flows through `handleInput` (the textarea is blurred
 * while an overlay is active, so the global sink dispatches). Idle Esc reads
 * the textarea's `plainText` (empty => double-Esc handler; non-empty =>
 * textarea clear). `handleEscKey` uses `Date.now`, so the window tests spy on
 * it directly (no fake timers — escape handling is synchronous).
 */
import type { InkKeyShape } from './opentui-chat-bridge.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bridgeTextareaKeyDown,
    createOpenTuiChatBridgeCore,
    handleInput,
    type OpenTuiChatBridgeCore,
} from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './opentui-chat-bridge-test-support.js';

const DOUBLE_ESC_ACTION_ENV = 'MCTRL_DOUBLE_ESC_ACTION';

function makeKey(overrides: Partial<InkKeyShape> = {}): InkKeyShape {
    return {
        upArrow: false,
        downArrow: false,
        leftArrow: false,
        rightArrow: false,
        pageDown: false,
        pageUp: false,
        home: false,
        end: false,
        return: false,
        escape: false,
        ctrl: false,
        shift: false,
        tab: false,
        backspace: false,
        delete: false,
        meta: false,
        super: false,
        hyper: false,
        capsLock: false,
        numLock: false,
        ...overrides,
    };
}

function nextEvent(core: OpenTuiChatBridgeCore): unknown {
    return core.eventQueue.shift();
}

/** Idle Esc: routed through the textarea keyDown (textarea focused). */
function pressEscIdle(
    core: OpenTuiChatBridgeCore,
    textareaRef = asTextareaRef(createRecordingTextarea()),
    scrollboxRef = asScrollboxRef(createRecordingScrollbox()),
): void {
    bridgeTextareaKeyDown(core, makeKeyEvent('escape'), textareaRef, scrollboxRef);
}

describe('opentui bridge double-Esc configurable action', () => {
    beforeEach(() => {
        vi.stubEnv(DOUBLE_ESC_ACTION_ENV, '');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    describe('default action: interrupt (force-stop stuck runs)', () => {
        it('records the timestamp on single Esc with an empty buffer', () => {
            vi.spyOn(Date, 'now').mockReturnValue(1_000);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);

            expect(core.lastEscTimestamp).toBe(1_000);
            expect(nextEvent(core)).toBeUndefined();
        });

        it('enqueues an esc-sourced interrupt on double Esc within the window', () => {
            vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);
            pressEscIdle(core);

            expect(nextEvent(core)).toEqual({
                type: 'interrupt',
                interruptedPartialInput: false,
                source: 'esc',
            });
        });

        it('does not fire when the second Esc falls outside the window', () => {
            vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);
            pressEscIdle(core);

            expect(nextEvent(core)).toBeUndefined();
            expect(core.lastEscTimestamp).toBe(2_000);
        });

        it('resets the timestamp after firing so a third Esc does not retrigger immediately', () => {
            vi.spyOn(Date, 'now')
                .mockReturnValueOnce(1_000)
                .mockReturnValueOnce(1_100)
                .mockReturnValueOnce(1_200);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);
            pressEscIdle(core);
            pressEscIdle(core);

            expect(nextEvent(core)).toEqual({
                type: 'interrupt',
                interruptedPartialInput: false,
                source: 'esc',
            });
            expect(nextEvent(core)).toBeUndefined();
            expect(core.lastEscTimestamp).toBe(1_200);
        });
    });

    describe('opt-in action: none (disable double-Esc)', () => {
        it('does nothing on single Esc when action is none', () => {
            vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'none');
            vi.spyOn(Date, 'now').mockReturnValue(1_000);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);

            expect(core.lastEscTimestamp).toBeUndefined();
            expect(nextEvent(core)).toBeUndefined();
        });

        it('does not enqueue any event on rapid Esc pressing when action is none', () => {
            vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'none');
            vi.spyOn(Date, 'now').mockReturnValue(1_000);
            const core = createOpenTuiChatBridgeCore();

            for (let i = 0; i < 5; i += 1) {
                pressEscIdle(core);
            }

            expect(nextEvent(core)).toBeUndefined();
            expect(core.lastEscTimestamp).toBeUndefined();
        });
    });

    describe('opt-in action: tree / fork', () => {
        it('records the timestamp on single Esc when action is tree', () => {
            vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'tree');
            vi.spyOn(Date, 'now').mockReturnValue(1_000);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);

            expect(core.lastEscTimestamp).toBe(1_000);
            expect(nextEvent(core)).toBeUndefined();
        });

        it('does not trigger when the second Esc falls outside the window (action=tree)', () => {
            vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'tree');
            vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);
            pressEscIdle(core);

            expect(nextEvent(core)).toBeUndefined();
            expect(core.lastEscTimestamp).toBe(2_000);
        });

        it('enqueues a /tree line event on double Esc when the action is set to tree', () => {
            vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'tree');
            vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);
            pressEscIdle(core);

            expect(nextEvent(core)).toEqual({ type: 'line', value: '/tree' });
        });

        it('enqueues a /fork line event on double Esc when the action is set to fork', () => {
            vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'fork');
            vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);
            pressEscIdle(core);

            expect(nextEvent(core)).toEqual({ type: 'line', value: '/fork' });
        });

        it('resets the timestamp after a double Esc so a third Esc does not trigger again immediately', () => {
            vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'tree');
            vi.spyOn(Date, 'now')
                .mockReturnValueOnce(1_000)
                .mockReturnValueOnce(1_100)
                .mockReturnValueOnce(1_200);
            const core = createOpenTuiChatBridgeCore();

            pressEscIdle(core);
            pressEscIdle(core);
            pressEscIdle(core);

            expect(nextEvent(core)).toEqual({ type: 'line', value: '/tree' });
            expect(nextEvent(core)).toBeUndefined();
            expect(core.lastEscTimestamp).toBe(1_200);
        });
    });

    describe('idle-state Esc clears the textarea buffer', () => {
        it('clears the textarea (and mirrors core.inputBuffer) on Esc with a non-empty buffer and skips double-Esc detection', () => {
            const core = createOpenTuiChatBridgeCore();
            const textarea = createRecordingTextarea('hello world');
            core.inputBuffer = 'hello world';

            pressEscIdle(core, asTextareaRef(textarea), asScrollboxRef(createRecordingScrollbox()));

            expect(textarea.clearCount).toBe(1);
            expect(core.inputBuffer).toBe('');
            expect(core.lastEscTimestamp).toBeUndefined();
            expect(nextEvent(core)).toBeUndefined();
        });
    });

    describe('mode interactions (Esc never reaches double-Esc handler)', () => {
        it('does not trigger double-Esc handling when the model picker is active', () => {
            vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'tree');
            const core = createOpenTuiChatBridgeCore();
            core.modelPickerActive = true;
            const previousTimestamp = 1_000;
            core.lastEscTimestamp = previousTimestamp;

            // Overlay active => textarea blurred => Esc arrives via handleInput.
            handleInput(core, '', makeKey({ escape: true }));

            expect(core.lastEscTimestamp).toBe(previousTimestamp);
            expect(core.modelPickerActive).toBe(true);
            expect(nextEvent(core)).toBeUndefined();
        });

        it('does not trigger double-Esc handling when rename mode is active (Esc cancels rename)', () => {
            const core = createOpenTuiChatBridgeCore();
            const onSubmit = vi.fn();
            core.onRenameSubmit = onSubmit;

            // Enter rename via the textarea keyDown (Ctrl+R), then type via the
            // overlay dispatch (handleInput while renameModeActive).
            bridgeTextareaKeyDown(
                core,
                makeKeyEvent('r', { ctrl: true }),
                asTextareaRef(createRecordingTextarea()),
                asScrollboxRef(createRecordingScrollbox()),
            );
            for (const ch of 'draft') {
                handleInput(core, ch, makeKey());
            }

            handleInput(core, '', makeKey({ escape: true }));

            expect(core.renameModeActive).toBe(false);
            expect(core.renameBuffer).toBe('');
            expect(onSubmit).not.toHaveBeenCalled();
            expect(core.lastEscTimestamp).toBeUndefined();
            expect(nextEvent(core)).toBeUndefined();
        });
    });

    describe('single Esc interrupts an active run while generating', () => {
        it('emits an esc-sourced interrupt on single Esc when generating is true', () => {
            const core = createOpenTuiChatBridgeCore();
            core.generating = true;

            pressEscIdle(core);

            expect(nextEvent(core)).toEqual({
                type: 'interrupt',
                interruptedPartialInput: false,
                source: 'esc',
            });
            expect(core.lastEscTimestamp).toBeUndefined();
        });

        it('emits an esc-sourced interrupt on every Esc press while generating (no double-Esc tracking)', () => {
            vi.spyOn(Date, 'now').mockReturnValue(1_000);
            const core = createOpenTuiChatBridgeCore();
            core.generating = true;

            pressEscIdle(core);
            pressEscIdle(core);

            expect(nextEvent(core)).toEqual({
                type: 'interrupt',
                interruptedPartialInput: false,
                source: 'esc',
            });
            expect(nextEvent(core)).toEqual({
                type: 'interrupt',
                interruptedPartialInput: false,
                source: 'esc',
            });
            expect(core.lastEscTimestamp).toBeUndefined();
        });

        it('preserves the textarea buffer when interrupting an active run', () => {
            const core = createOpenTuiChatBridgeCore();
            core.generating = true;
            const textarea = createRecordingTextarea('partial');
            core.inputBuffer = 'partial';

            pressEscIdle(core, asTextareaRef(textarea), asScrollboxRef(createRecordingScrollbox()));

            expect(nextEvent(core)).toEqual({
                type: 'interrupt',
                interruptedPartialInput: false,
                source: 'esc',
            });
            expect(core.inputBuffer).toBe('partial');
            expect(textarea.clearCount).toBe(0);
        });
    });
});
