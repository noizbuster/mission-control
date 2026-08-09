import { describe, expect, it } from 'vitest';
import {
    extractLastMessagePair,
    formatMessagePair,
    createUndoRedoStack,
    pushUndonePair,
    popUndonePair,
} from './interactive-chat-undo-redo-stack';

describe('extractLastMessagePair', () => {
    it('captures multi-line assistant blocks through the next strong boundary', () => {
        const text = [
            'You: first',
            'Assistant: one',
            'You: second',
            'Assistant: line a',
            'tool: ran',
            'line b',
            '',
        ].join('\n');
        const extracted = extractLastMessagePair(text);
        expect(extracted).toBeDefined();
        expect(extracted?.remaining).toBe(['You: first', 'Assistant: one', ''].join('\n'));
        expect(extracted?.pair.exchangeText).toContain('tool: ran');
        expect(formatMessagePair(extracted!.pair)).toBe(extracted!.pair.exchangeText);
        expect(extracted!.remaining + formatMessagePair(extracted!.pair)).toBe(text);
    });

    it('leaves an unanswered trailing You: line visible', () => {
        const text = 'You: done\nAssistant: ok\nYou: pending\n';
        const extracted = extractLastMessagePair(text);
        expect(extracted?.remaining).toBe('You: pending\n');
    });
});

describe('undo redo stack', () => {
    it('is LIFO and empty-safe', () => {
        let stack = createUndoRedoStack();
        stack = pushUndonePair(stack, { userText: 'a', assistantText: 'b' });
        stack = pushUndonePair(stack, { userText: 'c', assistantText: 'd' });
        const first = popUndonePair(stack);
        expect(first.pair?.userText).toBe('c');
        const second = popUndonePair(first.stack);
        expect(second.pair?.userText).toBe('a');
        const empty = popUndonePair(second.stack);
        expect(empty.pair).toBeUndefined();
    });
});
