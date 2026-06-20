import type { ModelProviderSelection } from '@mission-control/protocol';
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { createInkChatBridgeCore, handleInput, type InkChatBridgeCore } from './ink-chat-bridge.js';
import type { ModelChoice } from './interactive-chat-model.js';

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

function makeModelChoice(id: string, providerID: string, modelID: string): ModelChoice {
    return {
        id,
        label: id,
        selection: { providerID, modelID },
        capabilityStatus: 'executable',
        availableForCoding: true,
    };
}

describe('ink chat bridge Ctrl+P model cycling', () => {
    it('initializes modelCycleChoices empty and modelCycleIndex at 0', () => {
        const core = createInkChatBridgeCore();

        expect(core.modelCycleChoices).toEqual([]);
        expect(core.modelCycleIndex).toBe(0);
        expect(core.snapshot.modelCycleChoices).toEqual([]);
        expect(core.snapshot.modelCycleIndex).toBe(0);
    });

    it('is a no-op with an empty model cycle list', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [];

        handleInput(core, 'p', makeKey({ ctrl: true }));

        expect(core.modelCycleIndex).toBe(0);
    });

    it('is a no-op with a single model in the cycle list', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1')];

        handleInput(core, 'p', makeKey({ ctrl: true }));

        expect(core.modelCycleIndex).toBe(0);
    });

    it('cycles forward from index 0 to 1 with two models', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];

        handleInput(core, 'p', makeKey({ ctrl: true }));

        expect(core.modelCycleIndex).toBe(1);
        expect(core.snapshot.modelCycleIndex).toBe(1);
    });

    it('wraps forward past the end (0 -> 1 -> 0) with two models', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];

        handleInput(core, 'p', makeKey({ ctrl: true }));
        handleInput(core, 'p', makeKey({ ctrl: true }));

        expect(core.modelCycleIndex).toBe(0);
    });

    it('wraps backward from index 0 to 2 with three models on Shift+Ctrl+P', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [
            makeModelChoice('a', 'p1', 'm1'),
            makeModelChoice('b', 'p1', 'm2'),
            makeModelChoice('c', 'p1', 'm3'),
        ];

        handleInput(core, 'p', makeKey({ ctrl: true, shift: true }));

        expect(core.modelCycleIndex).toBe(2);
    });

    it('cycles backward from index 1 to 0 with three models on Shift+Ctrl+P', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [
            makeModelChoice('a', 'p1', 'm1'),
            makeModelChoice('b', 'p1', 'm2'),
            makeModelChoice('c', 'p1', 'm3'),
        ];
        core.modelCycleIndex = 1;

        handleInput(core, 'p', makeKey({ ctrl: true, shift: true }));

        expect(core.modelCycleIndex).toBe(0);
    });

    it('invokes onModelCycleSelect with the selected ModelProviderSelection', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];
        const onSelect = vi.fn();
        core.onModelCycleSelect = onSelect;

        handleInput(core, 'p', makeKey({ ctrl: true }));

        const expected: ModelProviderSelection = { providerID: 'p1', modelID: 'm2' };
        expect(onSelect).toHaveBeenCalledExactlyOnceWith(expected);
    });

    it('does not invoke onModelCycleSelect when the cycle list has only one model', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1')];
        const onSelect = vi.fn();
        core.onModelCycleSelect = onSelect;

        handleInput(core, 'p', makeKey({ ctrl: true }));

        expect(onSelect).not.toHaveBeenCalled();
    });

    it('appends p to the input buffer when ctrl is not held (regression)', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];

        handleInput(core, 'p', makeKey());

        expect(core.inputBuffer).toBe('p');
        expect(core.cursorPosition).toBe(1);
        expect(core.modelCycleIndex).toBe(0);
    });

    it('does not enqueue a chat event on Ctrl+P', () => {
        const core = createInkChatBridgeCore();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];

        handleInput(core, 'p', makeKey({ ctrl: true }));

        expect(core.eventQueue.shift()).toBeUndefined();
    });
});
