/** @jsxImportSource @opentui/solid */

import type { ModelProviderSelection } from '@mission-control/protocol';
import { testRender } from '@opentui/solid';
import { describe, expect, it, vi } from 'vitest';
import { createChatStore } from '../state/chat-store';
import { createModelsOverlayRoleRows } from '../state/models-overlay-state';
import { ModelsOverlay } from './ModelsOverlay';

vi.mock('../platform/providers/local-preferences-context', () => ({
    useTuiLocalPreferences: () => ({
        preferences: () => ({ modelContextPrefs: [] }),
        stepModelContextLimit: vi.fn(async () => undefined),
        stepModelAutoCompactThreshold: vi.fn(async () => undefined),
    }),
}));

// Drive useSolidStoreSelector with a real Solid signal so a single mounted
// instance updates when the store changes. This mirrors the production
// createSignal + subscribe wiring, but controlled explicitly so the headless
// testRender renderer repaints after a store mutation.
const pump = vi.hoisted(() => ({ current: (): void => {} }));

vi.mock('../platform/use-solid-store-selector', async (importOriginal) => {
    const original = await importOriginal<typeof import('../platform/use-solid-store-selector')>();
    // Static import is unreachable here: vi.mock factories are hoisted above all top-level imports.
    const solid = await import('solid-js');
    return {
        ...original,
        useSolidStoreSelector: <TSnapshot, TSelection>(
            store: { getSnapshot(): TSnapshot; subscribe(listener: () => void): () => void },
            selector: (snapshot: TSnapshot) => TSelection,
        ) => {
            const accessor = solid.createSignal(selector(store.getSnapshot()));
            pump.current = () => {
                accessor[1](() => selector(store.getSnapshot()));
            };
            return accessor[0];
        },
    };
});

function selection(providerID: string, modelID: string): ModelProviderSelection {
    return { providerID, modelID };
}

const ENTRIES: readonly ModelProviderSelection[] = [
    selection('openai', 'gpt-5'),
    selection('anthropic', 'claude-sonnet'),
    selection('google', 'gemini-pro'),
];

/**
 * Regression: the per-row focus highlight must update reactively when the
 * active index changes. The original render sampled `isFocused` as a plain
 * `const` inside <For>, which Solid evaluates once per row creation, so
 * navigation within the visible window never moved the `>` marker even though
 * the store updated. The pump-driven selector forces the same single-instance
 * update path the live TUI exercises.
 */
describe('ModelsOverlay focus reactivity', () => {
    it('moves the left-column focus marker when navigateModelsOverlay changes the index', async () => {
        const store = createChatStore();
        store.showModelsOverlay(ENTRIES, createModelsOverlayRoleRows({}, ENTRIES[0]!));
        const setup = await testRender(() => <ModelsOverlay store={store} />, { width: 100, height: 40 });

        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain('> openai/gpt-5');

            store.navigateModelsOverlay(1);
            pump.current();
            await setup.renderOnce();
            const frame1 = setup.captureCharFrame();
            expect(frame1).toContain('> anthropic/claude-sonnet');
            expect(frame1).not.toContain('> openai/gpt-5');

            store.navigateModelsOverlay(-1);
            pump.current();
            await setup.renderOnce();
            const frame2 = setup.captureCharFrame();
            expect(frame2).toContain('> openai/gpt-5');
            expect(frame2).not.toContain('> anthropic/claude-sonnet');
        } finally {
            setup.renderer.destroy();
        }
    });

    it('moves the right-column role focus after Tab switches columns', async () => {
        const store = createChatStore();
        store.showModelsOverlay(ENTRIES, createModelsOverlayRoleRows({}, ENTRIES[0]!));
        const setup = await testRender(() => <ModelsOverlay store={store} />, { width: 100, height: 40 });

        try {
            await setup.renderOnce();
            store.switchModelsOverlayColumn();
            pump.current();
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain('> default');

            store.navigateModelsOverlay(1);
            pump.current();
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain('> smol');
            expect(frame).not.toContain('> default');
        } finally {
            setup.renderer.destroy();
        }
    });
});
