/**
 * Test seam: Ctrl+P / Shift+Ctrl+P (model cycling) lives in the exported
 * `bridgeTextareaKeyDown`, which delegates to the internal `handleModelCycle`.
 * Drives the chord via a fake KeyEvent and asserts `core.modelCycleIndex`,
 * `core.onModelCycleSelect`, and the snapshot. Raw character input is native.
 */
import type { ModelProviderSelection } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { bridgeTextareaKeyDown, createOpenTuiChatBridgeCore } from './opentui-chat-bridge.js';
import type { ModelChoice } from './interactive-chat-model.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './chat-test-support.js';

function makeModelChoice(id: string, providerID: string, modelID: string): ModelChoice {
    return {
        id,
        label: id,
        selection: { providerID, modelID },
        capabilityStatus: 'executable',
        availableForCoding: true,
    };
}

function setup() {
    const core = createOpenTuiChatBridgeCore();
    const textareaRef = asTextareaRef(createRecordingTextarea());
    const scrollboxRef = asScrollboxRef(createRecordingScrollbox());
    return { core, textareaRef, scrollboxRef };
}

describe('opentui bridge Ctrl+P model cycling via bridgeTextareaKeyDown', () => {
    it('initializes modelCycleChoices empty and modelCycleIndex at 0', () => {
        const core = createOpenTuiChatBridgeCore();

        expect(core.modelCycleChoices).toEqual([]);
        expect(core.modelCycleIndex).toBe(0);
        expect(core.snapshot.modelCycleChoices).toEqual([]);
        expect(core.snapshot.modelCycleIndex).toBe(0);
    });

    it('is a no-op with an empty model cycle list', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [];

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.modelCycleIndex).toBe(0);
    });

    it('is a no-op with a single model in the cycle list', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1')];

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.modelCycleIndex).toBe(0);
    });

    it('cycles forward from index 0 to 1 with two models', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.modelCycleIndex).toBe(1);
        expect(core.snapshot.modelCycleIndex).toBe(1);
    });

    it('wraps forward past the end (0 -> 1 -> 0) with two models', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true }), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.modelCycleIndex).toBe(0);
    });

    it('wraps backward from index 0 to 2 with three models on Shift+Ctrl+P', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [
            makeModelChoice('a', 'p1', 'm1'),
            makeModelChoice('b', 'p1', 'm2'),
            makeModelChoice('c', 'p1', 'm3'),
        ];

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true, shift: true }), textareaRef, scrollboxRef);

        expect(core.modelCycleIndex).toBe(2);
    });

    it('cycles backward from index 1 to 0 with three models on Shift+Ctrl+P', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [
            makeModelChoice('a', 'p1', 'm1'),
            makeModelChoice('b', 'p1', 'm2'),
            makeModelChoice('c', 'p1', 'm3'),
        ];
        core.modelCycleIndex = 1;

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true, shift: true }), textareaRef, scrollboxRef);

        expect(core.modelCycleIndex).toBe(0);
    });

    it('invokes onModelCycleSelect with the selected ModelProviderSelection', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];
        const onSelect = vi.fn();
        core.onModelCycleSelect = onSelect;

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true }), textareaRef, scrollboxRef);

        const expected: ModelProviderSelection = { providerID: 'p1', modelID: 'm2' };
        expect(onSelect).toHaveBeenCalledExactlyOnceWith(expected);
    });

    it('does not invoke onModelCycleSelect when the cycle list has only one model', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1')];
        const onSelect = vi.fn();
        core.onModelCycleSelect = onSelect;

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true }), textareaRef, scrollboxRef);

        expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not enqueue a chat event on Ctrl+P', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];

        bridgeTextareaKeyDown(core, makeKeyEvent('p', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('is a no-op on the cycle index for a plain p (no ctrl) — raw typing is native textarea behavior', () => {
        const { core, textareaRef, scrollboxRef } = setup();
        core.modelCycleChoices = [makeModelChoice('a', 'p1', 'm1'), makeModelChoice('b', 'p1', 'm2')];

        bridgeTextareaKeyDown(core, makeKeyEvent('p'), textareaRef, scrollboxRef);

        expect(core.modelCycleIndex).toBe(0);
        expect(core.inputBuffer).toBe('');
    });
});
