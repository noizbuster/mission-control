import { describe, expect, it } from 'vitest';
import {
    createChatInputHistory,
    isNavigatingChatInputHistory,
    navigateChatInputHistoryDown,
    navigateChatInputHistoryUp,
    recordSubmittedPrompt,
} from './interactive-chat-input-history.js';

describe('chat input history', () => {
    it('starts empty and not navigating', () => {
        const history = createChatInputHistory();
        expect(history.entries).toEqual([]);
        expect(history.cursor).toBe(0);
        expect(isNavigatingChatInputHistory(history)).toBe(false);
    });

    it('records submitted prompts oldest-first and resets the cursor to the draft slot', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'hello');
        history = recordSubmittedPrompt(history, 'world');

        expect(history.entries).toEqual(['hello', 'world']);
        expect(history.cursor).toBe(2);
        expect(isNavigatingChatInputHistory(history)).toBe(false);
    });

    it('does not store empty submissions but still resets navigation', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'keep');
        const navigated = navigateChatInputHistoryUp(history, 'keep');
        history = navigated.history;

        history = recordSubmittedPrompt(history, '');

        expect(history.entries).toEqual(['keep']);
        expect(history.cursor).toBe(1);
        expect(isNavigatingChatInputHistory(history)).toBe(false);
    });

    it('Up recalls the newest entry first, then older entries', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'first');
        history = recordSubmittedPrompt(history, 'second');
        history = recordSubmittedPrompt(history, 'third');

        const up1 = navigateChatInputHistoryUp(history, 'draft');
        expect(up1.input).toBe('third');
        expect(up1.history.cursor).toBe(2);
        expect(isNavigatingChatInputHistory(up1.history)).toBe(true);

        const up2 = navigateChatInputHistoryUp(up1.history, up1.input);
        expect(up2.input).toBe('second');
        expect(up2.history.cursor).toBe(1);

        const up3 = navigateChatInputHistoryUp(up2.history, up2.input);
        expect(up3.input).toBe('first');
        expect(up3.history.cursor).toBe(0);
    });

    it('Up is a no-op when history is empty', () => {
        const history = createChatInputHistory();
        const result = navigateChatInputHistoryUp(history, 'current');
        expect(result.input).toBe('current');
        expect(result.history).toBe(history);
    });

    it('Up is a no-op when already at the oldest entry (keeps current edits)', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'only');
        const up1 = navigateChatInputHistoryUp(history, '');
        // user edits the recalled entry
        const up2 = navigateChatInputHistoryUp(up1.history, 'only-edited');
        expect(up2.input).toBe('only-edited');
        expect(up2.history.cursor).toBe(0);
    });

    it('Up captures the current input as draft when leaving the draft slot', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'stored');

        const up = navigateChatInputHistoryUp(history, 'work in progress');
        expect(up.history.draft).toBe('work in progress');

        const down = navigateChatInputHistoryDown(up.history, up.input);
        expect(down.input).toBe('work in progress');
        expect(isNavigatingChatInputHistory(down.history)).toBe(false);
    });

    it('Down moves toward newer entries and restores the draft past the newest', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'first');
        history = recordSubmittedPrompt(history, 'second');

        // navigate up to oldest
        const up1 = navigateChatInputHistoryUp(history, 'draft');
        const up2 = navigateChatInputHistoryUp(up1.history, up1.input);
        expect(up2.input).toBe('first');

        // down should show the newer entry
        const down1 = navigateChatInputHistoryDown(up2.history, up2.input);
        expect(down1.input).toBe('second');
        expect(isNavigatingChatInputHistory(down1.history)).toBe(true);

        // down again should restore the draft
        const down2 = navigateChatInputHistoryDown(down1.history, down1.input);
        expect(down2.input).toBe('draft');
        expect(isNavigatingChatInputHistory(down2.history)).toBe(false);
    });

    it('Down is a no-op when already at the draft slot', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'stored');

        const result = navigateChatInputHistoryDown(history, 'whatever');
        expect(result.input).toBe('whatever');
        expect(result.history).toBe(history);
    });

    it('a fresh submission after navigation resets to the draft slot', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'old');
        const up = navigateChatInputHistoryUp(history, 'partial');
        history = up.history;

        history = recordSubmittedPrompt(history, 'new');

        expect(history.cursor).toBe(history.entries.length);
        expect(isNavigatingChatInputHistory(history)).toBe(false);
        // navigating up now recalls the newest entry ("new"), not "old"
        const upAgain = navigateChatInputHistoryUp(history, '');
        expect(upAgain.input).toBe('new');
    });

    it('recalls slash commands as well as normal prompts', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, '/model openai/gpt-4o');
        history = recordSubmittedPrompt(history, 'what is 2+2?');

        const up = navigateChatInputHistoryUp(history, '');
        expect(up.input).toBe('what is 2+2?');
        const up2 = navigateChatInputHistoryUp(up.history, up.input);
        expect(up2.input).toBe('/model openai/gpt-4o');
    });

    it('handles repeated Up then Down cycles without losing the draft', () => {
        let history = createChatInputHistory();
        history = recordSubmittedPrompt(history, 'a');
        history = recordSubmittedPrompt(history, 'b');
        history = recordSubmittedPrompt(history, 'c');

        let input = 'mydraft';
        // walk all the way up
        for (let i = 0; i < 3; i += 1) {
            const result = navigateChatInputHistoryUp(history, input);
            history = result.history;
            input = result.input;
        }
        expect(input).toBe('a');
        // walk all the way back down
        for (let i = 0; i < 3; i += 1) {
            const result = navigateChatInputHistoryDown(history, input);
            history = result.history;
            input = result.input;
        }
        expect(input).toBe('mydraft');
        expect(isNavigatingChatInputHistory(history)).toBe(false);
    });
});
