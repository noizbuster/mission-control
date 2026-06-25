import type { InkKeyShape } from './opentui-chat-bridge.js';
import { describe, expect, it, vi } from 'vitest';
import {
    createOpenTuiChatBridgeCore,
    handleInput,
    type OpenTuiChatBridgeCore,
    normalizeQuestionOptions,
    publishSnapshot,
    type QuestionOption,
} from './opentui-chat-bridge.js';

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

function answers(resolve: ReturnType<typeof vi.fn>): readonly string[] {
    return resolve.mock.calls.map((call) => call[0]);
}

function openQuestion(
    core: OpenTuiChatBridgeCore,
    question: string,
    options: readonly (string | QuestionOption)[],
    metadata?: { readonly header?: string; readonly multiple?: boolean },
): ReturnType<typeof vi.fn> {
    const resolve = vi.fn();
    core.questionActive = true;
    core.questionText = question;
    core.questionHeader = metadata?.header ?? '';
    core.questionOptions = normalizeQuestionOptions(options);
    core.questionSelectedIndex = 0;
    core.questionMultiple = metadata?.multiple ?? false;
    core.questionSelectedIndices = new Set<number>();
    core.questionCustomMode = false;
    core.questionCustomBuffer = '';
    core.questionResolve = resolve;
    publishSnapshot(core);
    return resolve;
}

describe('ink chat bridge ask_user overlay v2 — labeled options and descriptions', () => {
    it('normalizes plain string options into { label } objects', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'Pick', ['A', 'B']);

        expect(core.questionOptions).toEqual([{ label: 'A' }, { label: 'B' }]);
    });

    it('normalizes labeled options preserving descriptions', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'Pick', [{ label: 'Red', description: 'warm color' }, { label: 'Blue' }]);

        expect(core.questionOptions).toEqual([{ label: 'Red', description: 'warm color' }, { label: 'Blue' }]);
    });

    it('accepts a mixed array of strings and labeled options', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'Pick', ['Plain', { label: 'Fancy', description: 'with detail' }]);

        expect(core.questionOptions).toEqual([{ label: 'Plain' }, { label: 'Fancy', description: 'with detail' }]);
    });

    it('exposes descriptions on the published snapshot for rendering', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'Pick', [{ label: 'A', description: 'desc-a' }]);

        expect(core.snapshot.questionOptions[0]?.description).toBe('desc-a');
    });

    it('seeds the header from metadata onto the core and snapshot', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'Which?', ['A'], { header: 'Choice 1 of 3' });

        expect(core.questionHeader).toBe('Choice 1 of 3');
        expect(core.snapshot.questionHeader).toBe('Choice 1 of 3');
    });
});

describe('ink chat bridge ask_user overlay v2 — single-select (default)', () => {
    it('navigates Down and resolves with the selected label on Enter', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = openQuestion(core, 'q', [
            { label: 'Red', description: 'warm' },
            { label: 'Blue', description: 'cool' },
        ]);

        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));

        expect(answers(resolve)).toEqual(['Blue']);
        expect(core.questionActive).toBe(false);
    });

    it('navigates Up wrapping to the trailing custom entry then to the last option', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'q', [{ label: 'A' }, { label: 'B' }]);

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.questionSelectedIndex).toBe(2);
        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.questionSelectedIndex).toBe(1);
    });

    it('enters custom mode and submits a typed answer', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = openQuestion(core, 'q', [{ label: 'A' }]);

        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));
        for (const ch of 'my own') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '\r', makeKey({ return: true }));

        expect(answers(resolve)).toEqual(['my own']);
    });

    it('cancels with an empty answer on Escape', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = openQuestion(core, 'q', [{ label: 'A' }]);

        handleInput(core, '', makeKey({ escape: true }));

        expect(answers(resolve)).toEqual(['']);
        expect(core.questionActive).toBe(false);
    });
});

describe('ink chat bridge ask_user overlay v2 — multi-select', () => {
    it('seeds multiple mode and an empty selection set', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'Pick many', [{ label: 'A' }, { label: 'B' }], { multiple: true });

        expect(core.questionMultiple).toBe(true);
        expect(core.questionSelectedIndices).toEqual(new Set<number>());
        expect(core.snapshot.questionMultiple).toBe(true);
    });

    it('toggles the cursor option on Space and reflects it in the set', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'q', [{ label: 'A' }, { label: 'B' }], { multiple: true });

        handleInput(core, ' ', makeKey());
        expect(core.questionSelectedIndices).toEqual(new Set<number>([0]));

        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, ' ', makeKey());
        expect(core.questionSelectedIndices).toEqual(new Set<number>([0, 1]));
    });

    it('toggles off an already-selected option on a second Space', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'q', [{ label: 'A' }, { label: 'B' }], { multiple: true });

        handleInput(core, ' ', makeKey());
        handleInput(core, ' ', makeKey());

        expect(core.questionSelectedIndices).toEqual(new Set<number>());
    });

    it('submits newline-joined labels of all checked options on Enter', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = openQuestion(
            core,
            'q',
            [{ label: 'Red', description: 'warm' }, { label: 'Green' }, { label: 'Blue', description: 'cool' }],
            { multiple: true },
        );

        handleInput(core, ' ', makeKey());
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, ' ', makeKey());
        handleInput(core, '\r', makeKey({ return: true }));

        expect(answers(resolve)).toEqual(['Red\nBlue']);
        expect(core.questionActive).toBe(false);
    });

    it('submits an empty string on Enter when nothing is checked', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = openQuestion(core, 'q', [{ label: 'A' }], { multiple: true });

        handleInput(core, '\r', makeKey({ return: true }));

        expect(answers(resolve)).toEqual(['']);
    });

    it('does not render a trailing custom entry (navigation wraps within options only)', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'q', [{ label: 'A' }, { label: 'B' }], { multiple: true });

        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ downArrow: true }));

        expect(core.questionSelectedIndex).toBe(0);
    });

    it('cancels with an empty answer on Escape', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = openQuestion(core, 'q', [{ label: 'A' }], { multiple: true });

        handleInput(core, ' ', makeKey());
        handleInput(core, '', makeKey({ escape: true }));

        expect(answers(resolve)).toEqual(['']);
        expect(core.questionActive).toBe(false);
    });

    it('cancels with an empty answer on Ctrl+C', () => {
        const core = createOpenTuiChatBridgeCore();
        const resolve = openQuestion(core, 'q', [{ label: 'A' }], { multiple: true });

        handleInput(core, ' ', makeKey());
        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(answers(resolve)).toEqual(['']);
    });

    it('clears multiple mode, selection set, and header on resolve', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'q', [{ label: 'A' }], { header: 'H', multiple: true });

        handleInput(core, ' ', makeKey());
        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.questionMultiple).toBe(false);
        expect(core.questionSelectedIndices).toEqual(new Set<number>());
        expect(core.questionHeader).toBe('');
        expect(core.snapshot.questionMultiple).toBe(false);
    });

    it('does not enqueue a chat line or interrupt event while the overlay is active', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'q', [{ label: 'A' }], { multiple: true });

        handleInput(core, ' ', makeKey());
        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(core.eventQueue).toEqual([]);
    });
});

describe('ink chat bridge ask_user overlay v2 — resolveQuestion resets all overlay state', () => {
    it('clears header, multiple flag, and selection set after a single-select resolution', () => {
        const core = createOpenTuiChatBridgeCore();
        openQuestion(core, 'q', [{ label: 'A', description: 'd' }], { header: 'H' });

        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.questionActive).toBe(false);
        expect(core.questionHeader).toBe('');
        expect(core.questionMultiple).toBe(false);
        expect(core.questionSelectedIndices).toEqual(new Set<number>());
    });
});
