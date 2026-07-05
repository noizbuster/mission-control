import { describe, expect, it } from 'vitest';
import { classifyLine, parseMessageBlocks } from './chat-blocks.js';

describe('classifyLine', () => {
    it('classifies a You: prefix as user', () => {
        expect(classifyLine('You: hi')).toBe('user');
    });

    it('classifies an Assistant: prefix as assistant', () => {
        expect(classifyLine('Assistant: hello')).toBe('assistant');
    });

    it('classifies an Error: prefix as error', () => {
        expect(classifyLine('Error: boom')).toBe('error');
    });

    it('classifies a Thinking: prefix as thinking', () => {
        expect(classifyLine('Thinking: hmm')).toBe('thinking');
    });

    it('classifies a tool failure line as tool', () => {
        expect(classifyLine('command.run failed: exit 1')).toBe('tool');
    });

    it('classifies a tool summary line as tool', () => {
        expect(classifyLine('\u2713 3 tools ran')).toBe('tool');
    });

    it.each([
        'Applied patch: foo.ts',
        'Applied edit: foo.ts',
        'Created file: foo.ts',
        'Replaced file: foo.ts',
        'Command output for bash.run',
        'tool: foo',
        'Edit preview for file.edit',
        'Patch preview for patch.x',
        'Command preview for command.run',
        'Write preview for write.x',
        'Replace preview for replace.x',
        'Create preview for create.x',
    ])('classifies %s prefix line as tool', (line) => {
        expect(classifyLine(line)).toBe('tool');
    });

    it('classifies an unrecognized line as system', () => {
        expect(classifyLine('just some prose')).toBe('system');
    });

    it('classifies a blank line as system (absorbed as paragraph separator)', () => {
        expect(classifyLine('')).toBe('system');
    });
});

describe('parseMessageBlocks', () => {
    it('returns an empty array for empty input', () => {
        expect(parseMessageBlocks('')).toEqual([]);
    });

    it('returns an empty array for a single blank line', () => {
        expect(parseMessageBlocks('\n')).toEqual([]);
    });

    it('parses a single user block', () => {
        expect(parseMessageBlocks('You: hi')).toEqual([{ kind: 'user', lines: ['You: hi'] }]);
    });

    it('parses a single assistant block', () => {
        expect(parseMessageBlocks('Assistant: hello')).toEqual([
            { kind: 'assistant', lines: ['Assistant: hello'] },
        ]);
    });

    it('parses a single thinking block', () => {
        expect(parseMessageBlocks('Thinking: hmm')).toEqual([
            { kind: 'thinking', lines: ['Thinking: hmm'] },
        ]);
    });

    it('parses a single error block', () => {
        expect(parseMessageBlocks('Error: boom')).toEqual([{ kind: 'error', lines: ['Error: boom'] }]);
    });

    it('parses a single tool block', () => {
        expect(parseMessageBlocks('tool: foo')).toEqual([{ kind: 'tool', lines: ['tool: foo'] }]);
    });

    it('parses a single system block', () => {
        expect(parseMessageBlocks('just some prose')).toEqual([
            { kind: 'system', lines: ['just some prose'] },
        ]);
    });

    it('keeps an interior blank line as a paragraph separator inside an assistant block', () => {
        const input = 'Assistant: para1\n\npara2';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'assistant', lines: ['Assistant: para1', '', 'para2'] },
        ]);
    });

    it('absorbs plain-text continuation lines into an assistant block', () => {
        const input = 'Assistant: line one\nline two\nline three';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'assistant', lines: ['Assistant: line one', 'line two', 'line three'] },
        ]);
    });

    it('absorbs plain-text continuation lines into a thinking block', () => {
        const input = 'Thinking: first\nsecond\nthird';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'thinking', lines: ['Thinking: first', 'second', 'third'] },
        ]);
    });

    it('absorbs non-strong-boundary lines into a tool block (diff content stays one block)', () => {
        const input = 'Edit preview for file.edit\nTarget: src/app.ts\n+added\n-removed';
        expect(parseMessageBlocks(input)).toEqual([
            {
                kind: 'tool',
                lines: ['Edit preview for file.edit', 'Target: src/app.ts', '+added', '-removed'],
            },
        ]);
    });

    it('does NOT absorb a strong-boundary line into a tool block (user starts a new block)', () => {
        const input = 'tool: foo\nYou: bar';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'tool', lines: ['tool: foo'] },
            { kind: 'user', lines: ['You: bar'] },
        ]);
    });

    it('does NOT absorb continuation into a user block (user is not an absorbing kind)', () => {
        const input = 'You: hi\nfollow-up prose';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'user', lines: ['You: hi'] },
            { kind: 'system', lines: ['follow-up prose'] },
        ]);
    });

    it('does NOT absorb continuation into an error block (error is a strong boundary)', () => {
        const input = 'Error: boom\nmore detail';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'error', lines: ['Error: boom'] },
            { kind: 'system', lines: ['more detail'] },
        ]);
    });

    it('trims trailing empty lines so a block never ends on a blank', () => {
        const input = 'You: hi\n\n';
        expect(parseMessageBlocks(input)).toEqual([{ kind: 'user', lines: ['You: hi'] }]);
    });

    it('trims trailing empty lines after an absorbing block too', () => {
        const input = 'Assistant: para1\n\npara2\n\n';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'assistant', lines: ['Assistant: para1', '', 'para2'] },
        ]);
    });

    it('parses a multi-section outputText into ordered blocks of distinct kinds', () => {
        const input = [
            'You: please edit foo.ts',
            'Thinking: planning the edit',
            'Edit preview for file.edit',
            '+new line',
            '-old line',
            'Assistant: done editing foo.ts',
            'Error: something went wrong',
        ].join('\n');
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'user', lines: ['You: please edit foo.ts'] },
            { kind: 'thinking', lines: ['Thinking: planning the edit'] },
            {
                kind: 'tool',
                lines: ['Edit preview for file.edit', '+new line', '-old line'],
            },
            { kind: 'assistant', lines: ['Assistant: done editing foo.ts'] },
            { kind: 'error', lines: ['Error: something went wrong'] },
        ]);
    });

    it('groups consecutive same-kind system lines into one block', () => {
        const input = 'banner line one\nbanner line two';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'system', lines: ['banner line one', 'banner line two'] },
        ]);
    });

    it('starts a new block when classification changes between consecutive lines', () => {
        const input = 'You: a\nYou: b';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'user', lines: ['You: a', 'You: b'] },
        ]);
    });

    it('treats a user line after an assistant block as a strong boundary (new block)', () => {
        const input = 'Assistant: reply\nYou: next question';
        expect(parseMessageBlocks(input)).toEqual([
            { kind: 'assistant', lines: ['Assistant: reply'] },
            { kind: 'user', lines: ['You: next question'] },
        ]);
    });

    it('captures all six block kinds in a single multi-section document', () => {
        const input = [
            'system banner',
            'You: the question',
            'Thinking: reasoning',
            'tool: ran a thing',
            'Assistant: the answer',
            'Error: oops',
        ].join('\n');
        const blocks = parseMessageBlocks(input);
        expect(blocks.map((b) => b.kind)).toEqual(['system', 'user', 'thinking', 'tool', 'assistant', 'error']);
    });
});
