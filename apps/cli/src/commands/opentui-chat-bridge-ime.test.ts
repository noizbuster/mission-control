import type { InkKeyShape } from './opentui-chat-bridge.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenTuiChatBridgeCore, handleInput, type OpenTuiChatBridgeCore, isCjkChar } from './opentui-chat-bridge.js';

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

describe('ink chat bridge IME/CJK composition buffering', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('commits an ASCII char immediately to the input buffer', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'a', makeKey());

        expect(core.inputBuffer).toBe('a');
        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.cjkCompositionTimer).toBeUndefined();
    });

    it('buffers a Hangul char in cjkCompositionBuffer instead of inputBuffer', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '안', makeKey());

        expect(core.cjkCompositionBuffer).toBe('안');
        expect(core.inputBuffer).toBe('');
        expect(core.cjkCompositionTimer).not.toBeUndefined();
    });

    it('flushes the CJK buffer to inputBuffer after the timeout fires', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '안', makeKey());
        expect(core.cjkCompositionBuffer).toBe('안');

        vi.advanceTimersByTime(50);

        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.inputBuffer).toBe('안');
        expect(core.cjkCompositionTimer).toBeUndefined();
    });

    it('accumulates two CJK chars and resets the timer on the second char', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '안', makeKey());
        handleInput(core, '녕', makeKey());

        expect(core.cjkCompositionBuffer).toBe('안녕');
        expect(core.inputBuffer).toBe('');

        vi.advanceTimersByTime(49);
        expect(core.cjkCompositionBuffer).toBe('안녕');

        vi.advanceTimersByTime(1);

        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.inputBuffer).toBe('안녕');
    });

    it('flushes the CJK buffer immediately when a non-CJK char follows', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '안', makeKey());
        expect(core.cjkCompositionBuffer).toBe('안');

        handleInput(core, 'a', makeKey());

        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.inputBuffer).toBe('안a');
        expect(core.cjkCompositionTimer).toBeUndefined();
    });

    it('flushes the CJK buffer before submitting on Enter', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '안', makeKey());
        expect(core.cjkCompositionBuffer).toBe('안');

        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.inputBuffer).toBe('');
        expect(nextEvent(core)).toEqual({ type: 'line', value: '안' });
    });

    it('flushes multiple buffered CJK chars in order after the timeout', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '중', makeKey());
        handleInput(core, '국', makeKey());
        handleInput(core, '어', makeKey());

        expect(core.cjkCompositionBuffer).toBe('중국어');

        vi.advanceTimersByTime(50);

        expect(core.inputBuffer).toBe('중국어');
        expect(core.cjkCompositionBuffer).toBe('');
    });

    it('classifies chars correctly via isCjkChar', () => {
        expect(isCjkChar('a')).toBe(false);
        expect(isCjkChar('안')).toBe(true);
        expect(isCjkChar('中')).toBe(true);
        expect(isCjkChar('あ')).toBe(true);
    });

    it('flushes the CJK buffer before processing Backspace', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '안', makeKey());

        handleInput(core, '', makeKey({ backspace: true }));

        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.inputBuffer).toBe('');
    });

    it('flushes the CJK buffer before processing Esc', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '안', makeKey());

        handleInput(core, '', makeKey({ escape: true }));

        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.inputBuffer).toBe('');
    });
});
