import { describe, expect, it } from 'vitest';
import {
    createProviderPromptKeypressState,
    createProviderPromptView,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';

const providerChoices = [
    { id: 'local', name: 'Local Sandbox' },
    { id: '302ai', name: '302.AI' },
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway' },
] as const;

describe('provider prompt keypress reducer', () => {
    it('submits numeric choices when the digit and enter arrive in one raw chunk', () => {
        const state = reduceProviderPromptKeypress(createProviderPromptKeypressState(), '2\r', providerChoices);

        expect(state).toEqual({
            selectedIndex: 1,
            pendingEscape: '',
            pendingNumberSelection: '',
            searchQuery: '',
            submitted: true,
            cancelled: false,
        });
    });

    it('submits j navigation when movement and enter arrive in one raw chunk', () => {
        const state = reduceProviderPromptKeypress(createProviderPromptKeypressState(), 'j\r', providerChoices);

        expect(state.selectedIndex).toBe(1);
        expect(state.submitted).toBe(true);
    });

    it('buffers split arrow escape sequences before submitting', () => {
        const pending = reduceProviderPromptKeypress(createProviderPromptKeypressState(), '\u001b', providerChoices);
        const moved = reduceProviderPromptKeypress(pending, '[B\r', providerChoices);

        expect(moved).toEqual({
            selectedIndex: 1,
            pendingEscape: '',
            pendingNumberSelection: '',
            searchQuery: '',
            submitted: true,
            cancelled: false,
        });
    });

    it('treats application cursor arrows as navigation without adding search text', () => {
        const moved = reduceProviderPromptKeypress(createProviderPromptKeypressState(), '\u001bOB', providerChoices);

        expect(moved.selectedIndex).toBe(1);
        expect(moved.searchQuery).toBe('');
        expect(moved.pendingEscape).toBe('');
    });

    it('treats modifier CSI arrows as navigation without adding search text', () => {
        const moved = reduceProviderPromptKeypress(createProviderPromptKeypressState(), '\u001b[1;5B', providerChoices);

        expect(moved.selectedIndex).toBe(1);
        expect(moved.searchQuery).toBe('');
        expect(moved.pendingEscape).toBe('');
    });

    it('keeps repeated identical down-arrow sequences as separate keypresses', () => {
        const moved = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[B\u001b[B',
            providerChoices,
        );

        expect(moved.selectedIndex).toBe(2);
        expect(moved.searchQuery).toBe('');
        expect(moved.pendingEscape).toBe('');
    });

    it('coalesces duplicated equivalent down-arrow reports from one physical keypress', () => {
        const moved = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[B\u001b[1;1B',
            providerChoices,
        );

        expect(moved.selectedIndex).toBe(1);
        expect(moved.searchQuery).toBe('');
        expect(moved.pendingEscape).toBe('');
    });

    it('coalesces duplicate equivalent down-arrow sequences in one raw input chunk', () => {
        const moved = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001bOB\u001b[1;1B',
            providerChoices,
        );

        expect(moved.selectedIndex).toBe(1);
        expect(moved.searchQuery).toBe('');
        expect(moved.pendingEscape).toBe('');
    });

    it('coalesces duplicate equivalent down-arrow sequences across adjacent chunks', () => {
        const applicationCursor = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001bOB',
            providerChoices,
        );
        const modifierCursor = reduceProviderPromptKeypress(applicationCursor, '\u001b[1;1B', providerChoices);

        expect(modifierCursor.selectedIndex).toBe(1);
        expect(modifierCursor.searchQuery).toBe('');
        expect(modifierCursor.pendingEscape).toBe('');
    });

    it('coalesces duplicate equivalent up-arrow sequences in one raw input chunk', () => {
        const start = reduceProviderPromptKeypress(createProviderPromptKeypressState(), 'jj', providerChoices);
        const moved = reduceProviderPromptKeypress(start, '\u001bOA\u001b[1;1A', providerChoices);

        expect(moved.selectedIndex).toBe(1);
        expect(moved.searchQuery).toBe('');
        expect(moved.pendingEscape).toBe('');
    });

    it('ignores Kitty-style down-arrow release events without adding search text', () => {
        const state = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[1;1:3B',
            providerChoices,
        );

        expect(state.selectedIndex).toBe(0);
        expect(state.searchQuery).toBe('');
        expect(state.pendingEscape).toBe('');
    });

    it('ignores Kitty-style up-arrow release events without adding search text', () => {
        const start = reduceProviderPromptKeypress(createProviderPromptKeypressState(), 'jj', providerChoices);
        const state = reduceProviderPromptKeypress(start, '\u001b[1;1:3A', providerChoices);

        expect(state.selectedIndex).toBe(2);
        expect(state.searchQuery).toBe('');
        expect(state.pendingEscape).toBe('');
    });

    it('keeps Kitty-style repeat arrow events as navigation', () => {
        const moved = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[B\u001b[1;1:2B',
            providerChoices,
        );

        expect(moved.selectedIndex).toBe(2);
        expect(moved.searchQuery).toBe('');
        expect(moved.pendingEscape).toBe('');
    });

    it('ignores malformed CSI arrow reports instead of treating them as navigation', () => {
        const unknownEvent = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[1;1:9B',
            providerChoices,
        );
        const invalidModifier = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[1;:2B',
            providerChoices,
        );

        expect(unknownEvent.selectedIndex).toBe(0);
        expect(unknownEvent.searchQuery).toBe('');
        expect(unknownEvent.pendingEscape).toBe('');
        expect(invalidModifier.selectedIndex).toBe(0);
        expect(invalidModifier.searchQuery).toBe('');
        expect(invalidModifier.pendingEscape).toBe('');
    });

    it('cancels on Kitty CSI-u Ctrl+C while modified keys are enabled', () => {
        const state = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[99;5u',
            providerChoices,
        );

        expect(state.cancelled).toBe(true);
        expect(state.pendingEscape).toBe('');
        expect(state.searchQuery).toBe('');
    });

    it('ignores Kitty CSI-u Ctrl+C release events while modified keys are enabled', () => {
        const state = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[99;5:3u',
            providerChoices,
        );

        expect(state.cancelled).toBe(false);
        expect(state.pendingEscape).toBe('');
        expect(state.searchQuery).toBe('');
    });

    it('cancels on xterm modifyOtherKeys Ctrl+C while modified keys are enabled', () => {
        const state = reduceProviderPromptKeypress(
            createProviderPromptKeypressState(),
            '\u001b[27;5;99~',
            providerChoices,
        );

        expect(state.cancelled).toBe(true);
        expect(state.pendingEscape).toBe('');
        expect(state.searchQuery).toBe('');
    });

    it('filters provider choices with typed search text before submitting', () => {
        const state = reduceProviderPromptKeypress(createProviderPromptKeypressState(), 'anth\r', providerChoices);
        const view = createProviderPromptView(state, providerChoices, 5);

        expect(state.searchQuery).toBe('anth');
        expect(state.submitted).toBe(true);
        expect(view.filteredChoices.map((choice) => choice.id)).toEqual(['anthropic']);
    });

    it('treats multiple typed digits as search text instead of a shortcut', () => {
        const state = reduceProviderPromptKeypress(createProviderPromptKeypressState(), '302', providerChoices);
        const view = createProviderPromptView(state, providerChoices, 5);

        expect(state.searchQuery).toBe('302');
        expect(view.filteredChoices.map((choice) => choice.id)).toEqual(['302ai']);
    });

    it('windows long provider lists around the selected search result', () => {
        const manyChoices = Array.from({ length: 20 }, (_, index) => ({
            id: `provider-${index + 1}`,
            name: `Provider ${index + 1}`,
        }));
        const moved = reduceProviderPromptKeypress(createProviderPromptKeypressState(), 'j'.repeat(12), manyChoices);
        const view = createProviderPromptView(moved, manyChoices, 5);

        expect(view.startIndex).toBeGreaterThan(0);
        expect(view.visibleChoices).toHaveLength(5);
        expect(view.visibleChoices.map((choice) => choice.id)).toContain('provider-13');
    });
});
