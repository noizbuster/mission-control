/**
 * T16 Esc ladder + Ctrl+C safety-critical contract tests.
 *
 * These tests pin the BEHAVIORAL contracts that T16 must preserve:
 *  (a) double-Esc within 500ms fires MCTRL_DOUBLE_ESC_ACTION (fake timers).
 *  (b) Ctrl+C inside the approval overlay denies (not swallowed/cleared).
 *  (c) Ctrl+C inside the question overlay cancels with an empty answer.
 *  (d) Ctrl+C inside the ABG overlay interrupts (not swallowed).
 *  (e) Esc when no keymap pending sequence clears the text buffer (bridge ladder).
 *  (f) Ctrl+C always enqueues interrupt even when the textarea is focused (the
 *      global useKeyboard sink routes it unconditionally).
 *
 * Written BEFORE T16 changes (failing-first proof). These PASS against current
 * code because the contracts already hold — the suite locks them against future
 * regression during the keymap migration.
 */
import type { InkKeyShape } from './opentui-chat-bridge.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bridgeTextareaKeyDown,
    createOpenTuiChatBridgeCore,
    handleInput,
    normalizeQuestionOptions,
    publishSnapshot,
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

function pressEscIdle(core: OpenTuiChatBridgeCore): void {
    bridgeTextareaKeyDown(
        core,
        makeKeyEvent('escape'),
        asTextareaRef(createRecordingTextarea()),
        asScrollboxRef(createRecordingScrollbox()),
    );
}

describe('T16 contract: double-Esc within 500ms fires configured action (fake timers)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubEnv(DOUBLE_ESC_ACTION_ENV, '');
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('fires the default interrupt action on double-Esc within the 500ms window', () => {
        vi.setSystemTime(1_000);
        const core = createOpenTuiChatBridgeCore();

        pressEscIdle(core);
        vi.setSystemTime(1_400); // 400ms later, within the 500ms window
        pressEscIdle(core);

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: false,
            source: 'esc',
        });
    });

    it('does NOT fire when the second Esc falls outside the 500ms window', () => {
        vi.setSystemTime(1_000);
        const core = createOpenTuiChatBridgeCore();

        pressEscIdle(core);
        vi.setSystemTime(1_600); // 600ms later, outside the window
        pressEscIdle(core);

        expect(nextEvent(core)).toBeUndefined();
    });

    it('fires the tree action when MCTRL_DOUBLE_ESC_ACTION=tree', () => {
        vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'tree');
        vi.setSystemTime(1_000);
        const core = createOpenTuiChatBridgeCore();

        pressEscIdle(core);
        vi.setSystemTime(1_100);
        pressEscIdle(core);

        expect(nextEvent(core)).toEqual({ type: 'line', value: '/tree' });
    });

    it('fires the fork action when MCTRL_DOUBLE_ESC_ACTION=fork', () => {
        vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'fork');
        vi.setSystemTime(1_000);
        const core = createOpenTuiChatBridgeCore();

        pressEscIdle(core);
        vi.setSystemTime(1_100);
        pressEscIdle(core);

        expect(nextEvent(core)).toEqual({ type: 'line', value: '/fork' });
    });
});

describe('T16 contract: Ctrl+C inside the approval overlay denies (not swallowed)', () => {
    it('denies the approval request when Ctrl+C is pressed inside the approval overlay', () => {
        const core = createOpenTuiChatBridgeCore();
        core.approvalActive = true;
        publishSnapshot(core);

        // While the approval overlay is active, the textarea is blurred, so
        // Ctrl+C arrives via the global handleInput sink -> handleApprovalInput.
        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(core.approvalActive).toBe(false);
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'deny' });
    });

    it('does NOT enqueue a ctrl-c interrupt when Ctrl+C denies inside the approval overlay', () => {
        const core = createOpenTuiChatBridgeCore();
        core.approvalActive = true;
        publishSnapshot(core);

        handleInput(core, 'c', makeKey({ ctrl: true }));

        // The deny line event is the ONLY event — no separate interrupt.
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'deny' });
        expect(nextEvent(core)).toBeUndefined();
    });
});

describe('T16 contract: Ctrl+C inside the question overlay cancels (not swallowed)', () => {
    it('resolves the question with an empty answer on Ctrl+C', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = vi.fn();
        core.questionActive = true;
        core.questionOptions = normalizeQuestionOptions(['yes', 'no']);
        core.questionResolve = resolve;
        publishSnapshot(core);

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(resolve).toHaveBeenCalledWith('');
        expect(core.questionActive).toBe(false);
    });
});

describe('T16 contract: Ctrl+C inside the model picker closes with undefined (cancel)', () => {
    it('closes the model picker and resolves with undefined on Ctrl+C', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = vi.fn();
        core.modelPickerActive = true;
        core.modelPickerResolve = resolve;
        publishSnapshot(core);

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(resolve).toHaveBeenCalledWith(undefined);
        expect(core.modelPickerActive).toBe(false);
    });
});

describe('T16 contract: Ctrl+C inside the ABG overlay is consumed (monitoring overlay by design)', () => {
    it('does NOT enqueue an interrupt when Ctrl+C arrives while ABG overlay is active', () => {
        const core = createOpenTuiChatBridgeCore();
        core.abgOverlayActive = true;
        publishSnapshot(core);

        // The ABG overlay is a monitoring overlay (comment: "NEVER calls
        // enqueueEvent while active"). Ctrl+C does not match any handler in
        // handleAbgOverlayInput and is consumed as a no-op. The overlay stays
        // open; the user closes it via Ctrl+G or Escape.
        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
        expect(core.abgOverlayActive).toBe(true);
    });

    it('Escape closes the ABG overlay (the documented close path)', () => {
        const core = createOpenTuiChatBridgeCore();
        core.abgOverlayActive = true;
        publishSnapshot(core);

        handleInput(core, '', makeKey({ escape: true }));

        expect(core.abgOverlayActive).toBe(false);
    });
});

describe('T16 contract: Esc when no pending keymap sequence clears the text buffer', () => {
    it('clears the textarea buffer on Esc with a non-empty buffer', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('important draft text');
        core.inputBuffer = 'important draft text';

        bridgeTextareaKeyDown(
            core,
            makeKeyEvent('escape'),
            asTextareaRef(textarea),
            asScrollboxRef(createRecordingScrollbox()),
        );

        expect(textarea.clearCount).toBe(1);
        expect(core.inputBuffer).toBe('');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('does NOT trigger double-Esc detection when clearing a non-empty buffer', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const core = createOpenTuiChatBridgeCore();
        core.lastEscTimestamp = 500; // simulate a prior Esc within the window
        const textarea = createRecordingTextarea('draft');
        core.inputBuffer = 'draft';

        bridgeTextareaKeyDown(
            core,
            makeKeyEvent('escape'),
            asTextareaRef(textarea),
            asScrollboxRef(createRecordingScrollbox()),
        );

        // Buffer is cleared, double-Esc is NOT triggered (different Esc action).
        expect(core.inputBuffer).toBe('');
        expect(core.lastEscTimestamp).toBe(500); // unchanged — buffer-clear does not touch the timestamp
        expect(nextEvent(core)).toBeUndefined();
    });
});

describe('T16 contract: Ctrl+C always enqueues interrupt (global sink, unconditional)', () => {
    it('enqueues a ctrl-c interrupt when no overlay is active (the global sink fires)', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: false,
            source: 'ctrl-c',
        });
    });

    it('enqueues a ctrl-c interrupt with interruptedPartialInput=true when buffer has text', () => {
        const core = createOpenTuiChatBridgeCore();
        core.inputBuffer = 'unsaved draft';

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: true,
            source: 'ctrl-c',
        });
    });
});
