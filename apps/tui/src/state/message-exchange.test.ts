import { describe, expect, it } from 'vitest';
import { extractLastExchange, reinsertExchange } from './message-exchange';

describe('extractLastExchange', () => {
    it('extracts a multi-line assistant block and leaves prior exchanges', () => {
        const text = [
            'You: first',
            'Assistant: one',
            'You: second',
            'Assistant: line a',
            'tool: ran',
            'line b',
            '',
        ].join('\n');
        const extracted = extractLastExchange(text);
        expect(extracted).toBeDefined();
        expect(extracted?.remaining).toBe(['You: first', 'Assistant: one', ''].join('\n'));
        expect(extracted?.exchangeText).toContain('You: second');
        expect(extracted?.exchangeText).toContain('line b');
        expect(reinsertExchange(extracted?.remaining ?? '', extracted?.exchangeText ?? '', extracted?.insertOffset ?? 0)).toBe(
            text,
        );
    });

    it('returns undefined when no complete exchange exists', () => {
        expect(extractLastExchange('')).toBeUndefined();
        expect(extractLastExchange('You: only\n')).toBeUndefined();
        expect(extractLastExchange('Assistant: orphan\n')).toBeUndefined();
    });

    it('does not undo an unanswered trailing You: line', () => {
        const text = 'You: done\nAssistant: ok\nYou: pending\n';
        const extracted = extractLastExchange(text);
        expect(extracted?.remaining).toBe('You: pending\n');
        expect(extracted?.exchangeText).toBe('You: done\nAssistant: ok\n');
    });
});
