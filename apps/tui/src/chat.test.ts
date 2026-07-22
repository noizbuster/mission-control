import { describe, expect, it } from 'vitest';
import { classifyLine, parseMessageBlocks } from './chat';

describe('parseMessageBlocks', () => {
    it('keeps broad tool summary classification for CLI consumers', () => {
        expect(classifyLine('✓ 3 tools ran')).toBe('tool');
    });

    it('omits exact aggregate display summaries while preserving individual legacy receipts', () => {
        const output = [
            'Applied patch: src/chat.ts',
            '✓ 2 tools (repo.read, grep)',
            'Command output for pnpm test',
            '✓ 2 tools (14ms)',
        ].join('\n');

        const blocks = parseMessageBlocks(output);

        expect(blocks).toEqual([
            {
                kind: 'tool',
                lines: ['Applied patch: src/chat.ts'],
            },
            {
                kind: 'tool',
                lines: ['Command output for pnpm test'],
            },
        ]);
    });

    it('splits consecutive legacy tool receipts while retaining ordinary multiline bodies', () => {
        expect(parseMessageBlocks('tool: legacy-one\nbody line\ntool: legacy-two')).toEqual([
            { kind: 'tool', lines: ['tool: legacy-one', 'body line'] },
            { kind: 'tool', lines: ['tool: legacy-two'] },
        ]);
    });
});
