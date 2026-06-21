import { describe, expect, it } from 'vitest';
import {
    getMessageWindowLineBudget,
    parseMessageBlocks,
    selectTrailingBlocks,
    type ChatBlock,
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
