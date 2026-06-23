import { describe, expect, it } from 'vitest';
import {
    type ChatBlock,
    getMessageWindowLineBudget,
    parseMessageBlocks,
    selectTrailingBlocks,
} from './ink-chat-bridge.js';

function kinds(blocks: readonly ChatBlock[]): readonly string[] {
    return blocks.map((block) => block.kind);
}

function firstBlockLines(blocks: readonly ChatBlock[], kind: ChatBlock['kind']): readonly string[] {
    const found = blocks.find((block) => block.kind === kind);
    return found?.lines ?? [];
}

describe('parseMessageBlocks — tool block sticky classification', () => {
    it('groups a tool preview with its diff content into a single tool block', () => {
        const output = [
            'Patch preview for file.patch',
            '--- a/foo.ts',
            '+++ b/foo.ts',
            '@@ -1,3 +1,3 @@',
            '-const x = 1;',
            '+const x = 2;',
            'Applied patch: foo.ts',
        ].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['tool']);
        expect(blocks[0]?.lines).toHaveLength(7);
    });

    it('keeps system lines inside a tool block until a strong boundary', () => {
        const output = [
            'Edit preview for file.edit',
            'Target: foo.ts (unique exact match)',
            '--- a/foo.ts',
            '+++ b/foo.ts',
            '-old line',
            '+new line',
            'Applied edit: foo.ts (1 occurrence)',
            '✓ 1 tool (file.edit)',
            'Assistant: Done editing.',
        ].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['tool', 'assistant']);
        const toolLines = firstBlockLines(blocks, 'tool');
        expect(toolLines).toContain('Target: foo.ts (unique exact match)');
        expect(toolLines).toContain('✓ 1 tool (file.edit)');
    });

    it('breaks the tool block when a user message follows', () => {
        const output = ['Command preview for command.run', '$ echo hi', 'You: thanks'].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['tool', 'user']);
    });

    it('starts a new tool block when a second tool preview follows assistant text', () => {
        const output = [
            'Edit preview for file.edit',
            'Target: a.ts (unique exact match)',
            '-old',
            '+new',
            'Applied edit: a.ts (1 occurrence)',
            'Assistant: Now editing the next file.',
            'Edit preview for file.edit',
            'Target: b.ts (unique exact match)',
            '-old2',
            '+new2',
            'Applied edit: b.ts (1 occurrence)',
        ].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['tool', 'assistant', 'tool']);
    });

    it('classifies thinking lines as a separate block from tool output', () => {
        const output = [
            'Thinking: Let me analyze this file.',
            'Thinking: I should check the imports first.',
            'Assistant: Let me read the file.',
        ].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['thinking', 'assistant']);
    });

    it('classifies collapsed tool indicators as tool blocks', () => {
        const output = ['tool: file.patch — ok', '[Ctrl+O to expand/collapse]'].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['tool']);
    });

    it('classifies tool failure messages as tool blocks', () => {
        const output = ['file.patch failed: workspace_escape: path escapes workspace'].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['tool']);
    });

    it('keeps non-tool system messages as system when not preceded by a tool start', () => {
        const output = ['Trusted project: /ws', 'resumed session: abc'].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['system']);
    });

    it('truncates a single long block to fit the line budget', () => {
        const lines: string[] = [];
        for (let i = 0; i < 100; i++) {
            lines.push(`Assistant: line ${i}`);
        }
        const output = lines.join('\n');

        const blocks = parseMessageBlocks(output);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.lines.length).toBe(100);

        // Simulate a 16-row terminal → budget = 16 - 8 = 8 lines
        const original = process.stdout.rows;
        Object.defineProperty(process.stdout, 'rows', { value: 16, configurable: true });
        try {
            const budget = getMessageWindowLineBudget();
            expect(budget).toBe(8);
            const { windowed, truncatedTop } = selectTrailingBlocks(blocks, budget);
            expect(truncatedTop).toBe(true);
            const totalLines = windowed.reduce((sum, block) => sum + block.lines.length, 0);
            expect(totalLines).toBeLessThanOrEqual(budget);
        } finally {
            Object.defineProperty(process.stdout, 'rows', { value: original, configurable: true });
        }
    });
});

// Reconstruct the MessageBlock join contract (strip prefix from line 0, join with \n)
// to assert that a parsed assistant/thinking block reconstructs its source markdown.
function joinedMarkdown(block: ChatBlock, prefix: string): string {
    const first = block.lines[0] ?? '';
    const rest = block.lines.slice(1);
    const stripped = prefix.length > 0 && first.startsWith(prefix) ? first.slice(prefix.length) : first;
    return [stripped, ...rest].join('\n');
}

describe('parseMessageBlocks — markdown-unit preservation (T6)', () => {
    it('keeps a multi-paragraph assistant message as ONE block with blank lines intact', () => {
        // Pre-fix behavior (characterization): this fragmented into [assistant(1 line), system(1 line)]
        // and the blank line was dropped, so the joined text lost the paragraph break.
        const blocks = parseMessageBlocks('Assistant: para1\n\npara2\n');

        expect(kinds(blocks)).toEqual(['assistant']);
        expect(blocks[0]?.lines).toEqual(['Assistant: para1', '', 'para2']);
        // The renderer joins block.lines (stripping the prefix from line 0) into one
        // markdown document that reconstructs both paragraphs separated by a blank line.
        expect(joinedMarkdown(blocks[0] as ChatBlock, 'Assistant: ')).toBe('para1\n\npara2');
    });

    it('absorbs plain-text continuation lines into an assistant block (no fragmentation)', () => {
        const output = ['Assistant: line one', 'line two continued', '', 'line three'].join('\n');
        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['assistant']);
        expect(blocks[0]?.lines.length).toBe(4);
        expect(joinedMarkdown(blocks[0] as ChatBlock, 'Assistant: ')).toBe(
            'line one\nline two continued\n\nline three',
        );
    });

    it('absorbs blank lines and continuation into a thinking block', () => {
        const output = ['Thinking: first thought', '', 'second thought', 'Assistant: answer'].join('\n');
        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['thinking', 'assistant']);
        const thinking = blocks.find((b) => b.kind === 'thinking') as ChatBlock;
        expect(thinking.lines).toEqual(['Thinking: first thought', '', 'second thought']);
        expect(joinedMarkdown(thinking, 'Thinking: ')).toBe('first thought\n\nsecond thought');
    });

    it('does NOT absorb a tool-preview line into an assistant block (tool cards stay separate)', () => {
        const output = ['Assistant: done', 'Edit preview for file.edit', 'Target: a.ts'].join('\n');
        const blocks = parseMessageBlocks(output);

        // The assistant block must NOT swallow the tool preview — it stays a tool block
        // so T7 tool-card rendering keeps working.
        expect(kinds(blocks)).toEqual(['assistant', 'tool']);
        expect(joinedMarkdown(blocks[0] as ChatBlock, 'Assistant: ')).toBe('done');
    });

    it('drops leading and trailing blank lines but keeps interior ones', () => {
        const output = '\n\nAssistant: hi\n\nbye\n\n';
        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['assistant']);
        expect(blocks[0]?.lines).toEqual(['Assistant: hi', '', 'bye']);
    });

    it('renders a bold-heading assistant block as markdown (not a literal #)', () => {
        // The renderer feeds this joined text to <Markdown>; the stopping condition is
        // that '# Heading' renders bold, not as literal '#'. Here we assert the parser
        // produces a single assistant block whose joined text is well-formed markdown
        // that marked.lexer will tokenize as a heading (verified in Markdown.test.tsx).
        const output = 'Assistant: # Title\n\nbody text';
        const blocks = parseMessageBlocks(output);

        expect(kinds(blocks)).toEqual(['assistant']);
        expect(joinedMarkdown(blocks[0] as ChatBlock, 'Assistant: ')).toBe('# Title\n\nbody text');
    });

    it('marks truncated non-markdown blocks and drops whole markdown blocks for budget', () => {
        // System lines come FIRST so they form a standalone system block (system
        // lines following an assistant line are correctly absorbed as continuation).
        // An overflowing system block gets tail-sliced + marked `truncated`; an
        // overflowing markdown (assistant/thinking) block gets dropped whole.
        const blocks = parseMessageBlocks(
            ['system note one', 'system note two', 'system note three', 'Assistant: short answer'].join('\n'),
        );
        expect(kinds(blocks)).toEqual(['system', 'assistant']);

        const original = process.stdout.rows;
        Object.defineProperty(process.stdout, 'rows', { value: 16, configurable: true });
        try {
            // budget = 8; system (3 lines) + assistant (1 line) = 4 ≤ 8, no truncation.
            const { truncatedTop, windowed } = selectTrailingBlocks(blocks, getMessageWindowLineBudget());
            expect(truncatedTop).toBe(false);
            expect(windowed).toHaveLength(2);
        } finally {
            Object.defineProperty(process.stdout, 'rows', { value: original, configurable: true });
        }

        // Budget 2: assistant(1) fits, system(3) overflows and is tail-sliced.
        const { windowed, truncatedTop } = selectTrailingBlocks(blocks, 2);
        const sys = windowed.find((b) => b.kind === 'system');
        expect(sys?.truncated).toBe(true);
        expect(truncatedTop).toBe(true);
    });

    it('drops a whole markdown block when it alone exceeds the budget', () => {
        const big: string[] = ['Assistant: '];
        for (let i = 0; i < 30; i++) big.push(`line ${i}`);
        const blocks = parseMessageBlocks(big.join('\n'));
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.kind).toBe('assistant');

        const { windowed, truncatedTop } = selectTrailingBlocks(blocks, 8);
        // Markdown block dropped whole (no partial slice that could split a fence).
        expect(truncatedTop).toBe(true);
        expect(windowed).toEqual([]);
    });
});
