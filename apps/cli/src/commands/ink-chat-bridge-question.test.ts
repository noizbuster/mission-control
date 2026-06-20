import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { createInkChatBridgeCore, handleInput, type InkChatBridgeCore } from './ink-chat-bridge.js';

function makeKey(overrides: Partial<Key> = {}): Key {
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

/**
 * Mirror what the public `showQuestion` bridge method does: flip the overlay on, seed state,
 * and register the resolve callback the tool awaits. Driven directly on the core so the test
 * does not need to mount the Ink tree. Returns the resolve mock so the caller can assert on it
 * after the field is cleared by `resolveQuestion`.
 */
function openQuestion(core: InkChatBridgeCore, question: string, options: readonly string[]): ReturnType<typeof vi.fn> {
    const resolve = vi.fn();
    core.questionActive = true;
    core.questionText = question;
    core.questionOptions = options;
    core.questionSelectedIndex = 0;
    core.questionCustomMode = false;
    core.questionCustomBuffer = '';
    core.questionResolve = resolve;
    return resolve;
}

function answers(resolve: ReturnType<typeof vi.fn>): readonly string[] {
    return resolve.mock.calls.map((call) => call[0]);
}

describe('ink chat bridge ask_user question overlay', () => {
    it('seeds the question text, options, and defaults to the first option', () => {
        const core = createInkChatBridgeCore();
        openQuestion(core, 'Pick one', ['A', 'B']);

        expect(core.questionActive).toBe(true);
        expect(core.questionText).toBe('Pick one');
        expect(core.questionOptions).toEqual(['A', 'B']);
        expect(core.questionSelectedIndex).toBe(0);
        expect(core.questionCustomMode).toBe(false);
        expect(core.questionCustomBuffer).toBe('');
    });

    it('navigates Down through options and the trailing custom entry, wrapping back to the first', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A', 'B']);

        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.questionSelectedIndex).toBe(1);
        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.questionSelectedIndex).toBe(2); // virtual "Type custom answer..." entry
        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.questionSelectedIndex).toBe(0); // wraps
    });

    it('navigates Up wrapping from the first entry to the custom entry', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A', 'B']);

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.questionSelectedIndex).toBe(2); // wraps to the custom entry
    });

    it('resolves with the selected option on Enter and closes the overlay', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A', 'B']);

        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));

        expect(answers(resolve)).toEqual(['B']);
        expect(core.questionActive).toBe(false);
        expect(core.snapshot.questionActive).toBe(false);
    });

    it('enters custom mode when the trailing custom entry is selected and Enter is pressed', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A']);

        handleInput(core, '', makeKey({ downArrow: true })); // index 1 -> custom entry
        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.questionCustomMode).toBe(true);
        expect(core.questionCustomBuffer).toBe('');
        expect(core.questionActive).toBe(true);
        expect(answers(resolve)).toEqual([]);
    });

    it('accumulates typed text in custom mode and submits on Enter', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A']);
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));

        for (const ch of 'maybe') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '\r', makeKey({ return: true }));

        expect(answers(resolve)).toEqual(['maybe']);
        expect(core.questionActive).toBe(false);
    });

    it('appends text-before-return to the custom buffer on batched Enter input', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A']);
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));

        handleInput(core, 'yes\r', makeKey({ return: true }));

        expect(answers(resolve)).toEqual(['yes']);
    });

    it('deletes the last char on Backspace in custom mode', () => {
        const core = createInkChatBridgeCore();
        openQuestion(core, 'q', ['A']);
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));
        for (const ch of 'hello') {
            handleInput(core, ch, makeKey());
        }

        handleInput(core, '', makeKey({ backspace: true }));

        expect(core.questionCustomBuffer).toBe('hell');
    });

    it('returns to option selection on Escape from custom mode without resolving', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A']);
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));
        for (const ch of 'draft') {
            handleInput(core, ch, makeKey());
        }

        handleInput(core, '', makeKey({ escape: true }));

        expect(core.questionCustomMode).toBe(false);
        expect(core.questionCustomBuffer).toBe('');
        expect(core.questionActive).toBe(true);
        expect(answers(resolve)).toEqual([]);
    });

    it('cancels with an empty answer on Escape from selection mode', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A', 'B']);

        handleInput(core, '', makeKey({ escape: true }));

        expect(answers(resolve)).toEqual(['']);
        expect(core.questionActive).toBe(false);
    });

    it('cancels with an empty answer on Ctrl+C from selection mode', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A', 'B']);

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(answers(resolve)).toEqual(['']);
        expect(core.questionActive).toBe(false);
    });

    it('cancels with an empty answer on Ctrl+C from custom mode', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A']);
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));
        for (const ch of 'x') {
            handleInput(core, ch, makeKey());
        }

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(answers(resolve)).toEqual(['']);
        expect(core.questionActive).toBe(false);
    });

    it('does not enqueue a chat line or interrupt event while the overlay is active', () => {
        const core = createInkChatBridgeCore();
        const resolve = openQuestion(core, 'q', ['A']);

        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(core.eventQueue).toEqual([]);
    });

    it('works with no options (only the custom entry is selectable)', () => {
        const core = createInkChatBridgeCore();
        openQuestion(core, 'free-form', []);

        expect(core.questionSelectedIndex).toBe(0);
        handleInput(core, '\r', makeKey({ return: true }));
        expect(core.questionCustomMode).toBe(true);
    });
});
