import type { ModelProviderSelection } from '@mission-control/protocol';
import type { KeyEvent } from '@opentui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStore } from '../state/chat-store';
import { createChatStore } from '../state/chat-store';
import type { ModelChoice } from '../state/interactive-chat-model';
import { createModelsOverlayRoleRows } from '../state/models-overlay-state';
import { makeKeyEvent } from './chat-test-support';
import { ModelsOverlay } from './ModelsOverlay';
import { ModelPickerOverlay } from './OverlayPanels';

let keyboardHandler: ((key: KeyEvent) => void) | undefined;
let overlayFooter: string | undefined;

const preferenceCalls = {
    context: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
};

vi.mock('@opentui/solid', async (importOriginal) => {
    const original = await importOriginal<typeof import('@opentui/solid')>();
    return {
        ...original,
        useKeyboard: (handler: (key: KeyEvent) => void) => {
            keyboardHandler = handler;
        },
    };
});

vi.mock('../platform/providers/local-preferences-context', () => ({
    useTuiLocalPreferences: () => ({
        preferences: () => ({ modelContextPrefs: [] }),
        stepModelContextLimit: preferenceCalls.context,
        stepModelAutoCompactThreshold: preferenceCalls.compact,
    }),
}));

vi.mock('../platform/use-solid-store-selector', () => ({
    useSolidStoreSelector:
        <Result,>(store: ChatStore, selector: (snapshot: ReturnType<ChatStore['getSnapshot']>) => Result) =>
        () =>
            selector(store.getSnapshot()),
}));

vi.mock('./OverlayFrame', () => ({
    OverlayFrame: (props: { readonly footer: string }) => {
        overlayFooter = props.footer;
        return undefined;
    },
}));

const PRINTABLE_SEARCH = '/-=+[]jk';

function modelSelection(providerID: string, modelID: string): ModelProviderSelection {
    return { providerID, modelID };
}

function modelChoice(providerID: string, modelID: string): ModelChoice {
    return {
        id: `${providerID}/${modelID}`,
        label: `${providerID}/${modelID}`,
        selection: modelSelection(providerID, modelID),
        capabilityStatus: 'executable',
        availableForCoding: true,
    };
}

function keyboardFor(render: () => unknown): (key: KeyEvent) => void {
    render();
    const handler = keyboardHandler;
    if (handler === undefined) {
        throw new Error('Expected component to register a keyboard handler');
    }
    return handler;
}

describe('model overlay printable keyboard routing', () => {
    beforeEach(() => {
        keyboardHandler = undefined;
        overlayFooter = undefined;
        preferenceCalls.context.mockClear();
        preferenceCalls.compact.mockClear();
    });

    it('routes /model bare printable characters into search without changing preferences', () => {
        // Given: an active model picker with one selectable model
        const store = createChatStore();
        void store.showModelPicker([modelChoice('openai', 'gpt-5')]);
        const handleKey = keyboardFor(() => ModelPickerOverlay({ store }));

        // When: every printable character is entered without a modifier
        const events = [...PRINTABLE_SEARCH].map((character) => makeKeyEvent(character));
        for (const event of events) {
            handleKey(event);
        }

        // Then: the literal sequence is searchable, consumed, and leaves preferences unchanged
        expect(store.getSnapshot().modelPickerKeypress.searchQuery).toBe(PRINTABLE_SEARCH);
        expect(events.every((event) => event.defaultPrevented)).toBe(true);
        expect(preferenceCalls.context).not.toHaveBeenCalled();
        expect(preferenceCalls.compact).not.toHaveBeenCalled();
        expect(overlayFooter).toBe(
            '↑↓ navigate · ←→ context · Ctrl+←→ compact · type search · Enter select · Esc cancel',
        );
    });

    it('routes /models bare printable characters into search without changing preferences', () => {
        // Given: the full models overlay is focused on an available model
        const store = createChatStore();
        const selection = modelSelection('openai', 'gpt-5');
        store.showModelsOverlay([selection], createModelsOverlayRoleRows({}, selection));
        const handleKey = keyboardFor(() => ModelsOverlay({ store }));

        // When: every printable character is entered without a modifier
        const events = [...PRINTABLE_SEARCH].map((character) => makeKeyEvent(character));
        for (const event of events) {
            handleKey(event);
        }

        // Then: the literal sequence is searchable, consumed, and leaves preferences unchanged
        expect(store.getSnapshot().modelsOverlay.searchQuery).toBe(PRINTABLE_SEARCH);
        expect(events.every((event) => event.defaultPrevented)).toBe(true);
        expect(preferenceCalls.context).not.toHaveBeenCalled();
        expect(preferenceCalls.compact).not.toHaveBeenCalled();
        expect(overlayFooter).toBe(
            '← → provider · Shift+←→ context · Ctrl+←→ compact · type search · ↑↓ · Tab · ⏎ assign · Esc',
        );
    });

    it('keeps /model arrows and Ctrl navigation while Ctrl adjusts compacting', () => {
        // Given: an active model picker with two selectable models
        const store = createChatStore();
        void store.showModelPicker([modelChoice('openai', 'gpt-5'), modelChoice('anthropic', 'claude-sonnet')]);
        const handleKey = keyboardFor(() => ModelPickerOverlay({ store }));

        // When: arrows, Ctrl navigation, context, and compact controls are invoked
        const navigationKey = makeKeyEvent('up');
        const ctrlDownKey = makeKeyEvent('n', { ctrl: true });
        const ctrlUpKey = makeKeyEvent('p', { ctrl: true });
        const contextKey = makeKeyEvent('left');
        const compactKey = makeKeyEvent('right', { ctrl: true });
        handleKey(navigationKey);
        expect(store.getSnapshot().modelPickerKeypress.selectedIndex).toBe(1);
        handleKey(ctrlDownKey);
        expect(store.getSnapshot().modelPickerKeypress.selectedIndex).toBe(0);
        handleKey(ctrlUpKey);
        handleKey(contextKey);
        handleKey(compactKey);

        // Then: nonprintable and modified navigation stay distinct from preference arrows
        expect(navigationKey.defaultPrevented).toBe(true);
        expect(ctrlDownKey.defaultPrevented).toBe(true);
        expect(ctrlUpKey.defaultPrevented).toBe(true);
        expect(store.getSnapshot().modelPickerKeypress.selectedIndex).toBe(1);
        expect(store.getSnapshot().modelPickerKeypress.searchQuery).toBe('');
        expect(contextKey.defaultPrevented).toBe(true);
        expect(compactKey.defaultPrevented).toBe(true);
        expect(preferenceCalls.context).toHaveBeenCalledOnce();
        expect(preferenceCalls.compact).toHaveBeenCalledOnce();
    });

    it('keeps /models provider tabs on arrows with Shift context and Ctrl compacting', () => {
        // Given: a full models overlay with two provider tabs
        const store = createChatStore();
        const selection = modelSelection('openai', 'gpt-5');
        store.showModelsOverlay(
            [selection, modelSelection('anthropic', 'claude-sonnet')],
            createModelsOverlayRoleRows({}, selection),
        );
        const handleKey = keyboardFor(() => ModelsOverlay({ store }));

        // When: Right moves the provider tab, Shift+Right adjusts context, and Ctrl+Right adjusts compacting
        handleKey(makeKeyEvent('right'));
        handleKey(makeKeyEvent('right', { shift: true }));
        handleKey(makeKeyEvent('right', { ctrl: true }));

        // Then: each chord retains its distinct action
        expect(store.getSnapshot().modelsOverlay.activeProviderTab).toBe('anthropic');
        expect(preferenceCalls.context).toHaveBeenCalledOnce();
        expect(preferenceCalls.compact).toHaveBeenCalledOnce();
    });
});
