import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { renderSummary, summarizeHead } from './compaction.js';
import { packContext } from './context-packer.js';
import { estimateMessagesTokens } from './token-count.js';

function user(text: string): ModelMessage {
    return { role: 'user', content: text };
}
function assistant(text: string): ModelMessage {
    return { role: 'assistant', content: text };
}

describe('packContext', () => {
    it('does not compact when the conversation fits the budget', () => {
        const messages = [user('hi'), assistant('hello')];
        const packed = packContext({ messages, budgetTokens: 100_000 });
        expect(packed.compacted).toBe(false);
        expect(packed.messages).toEqual(messages);
        expect(packed.cutPointIndex).toBeUndefined();
    });

    it('compacts the head into a summary and preserves the recent tail verbatim', () => {
        const messages: ModelMessage[] = [user('Build a feature')];
        for (let index = 0; index < 40; index += 1) {
            messages.push(assistant(`thinking step ${index} with padding text to grow tokens `.repeat(20)));
        }
        const fullTokens = estimateMessagesTokens(messages);
        const packed = packContext({ messages, budgetTokens: 1000, tailReserveTokens: 400 });

        expect(packed.compacted).toBe(true);
        expect(packed.summary).toBeDefined();
        expect(packed.cutPointIndex).toBeGreaterThan(0);
        // Leading summary is a system message; the tail is preserved verbatim at the end.
        expect(packed.messages[0]?.role).toBe('system');
        expect(packed.messages[packed.messages.length - 1]).toEqual(messages[messages.length - 1]);
        // Compaction shrank the model-facing view below the full conversation, and it is
        // bounded (the summary has fixed item caps) regardless of how long the run grows.
        expect(packed.estimatedTokens).toBeLessThan(fullTokens);
        expect(packed.estimatedTokens).toBeLessThan(4500);
    });

    it('incorporates a prior summary (iterative compaction)', () => {
        const prior = summarizeHead([user('original goal')], undefined);
        const messages: ModelMessage[] = [assistant('new step')];
        for (let index = 0; index < 20; index += 1) {
            messages.push(assistant(`additional reasoning ${index} padded to grow tokens `.repeat(6)));
        }
        const packed = packContext({ messages, budgetTokens: 300, tailReserveTokens: 120, priorSummary: prior });

        expect(packed.compacted).toBe(true);
        expect(packed.summary?.goal).toBe(prior.goal);
        expect(packed.summary?.summarizedMessageCount).toBeGreaterThan(prior.summarizedMessageCount);
    });

    it('renders a human-readable structured summary', () => {
        const summary = summarizeHead([user('ship it'), assistant('decided X')], undefined);
        const rendered = renderSummary(summary);
        expect(rendered).toContain('Goal: ship it');
        expect(rendered).toContain('decided X');
    });
});
