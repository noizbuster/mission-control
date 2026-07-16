import { describe, expect, it } from 'vitest';
import { formatToolArgsSummary, formatToolCallActivity, formatToolResultActivity } from './interactive-coding-tool-activity';

describe('formatToolCallActivity', () => {
    it('formats glob calls with pattern', () => {
        expect(
            formatToolCallActivity({
                toolCallId: 'c1',
                toolName: 'glob',
                argumentsJson: JSON.stringify({ pattern: '**/*.ts' }),
            }),
        ).toBe('tool: glob **/*.ts');
    });

    it('formats bash.run with command line', () => {
        expect(
            formatToolCallActivity({
                toolCallId: 'c2',
                toolName: 'bash.run',
                argumentsJson: JSON.stringify({ commandLine: 'pnpm test' }),
            }),
        ).toBe('tool: bash.run pnpm test');
    });
});

describe('formatToolArgsSummary', () => {
    it('formats command.run as shell-like', () => {
        expect(
            formatToolArgsSummary('command.run', JSON.stringify({ command: 'node', args: ['--test', 'a.ts'] })),
        ).toBe('$ node --test a.ts');
    });
});

describe('formatToolResultActivity', () => {
    it('formats failures with redacted message', () => {
        expect(
            formatToolResultActivity('glob', 'failed', {
                errorMessage: 'path not found',
            }),
        ).toBe('glob failed: path not found');
    });

    it('formats specialized file.patch success', () => {
        expect(
            formatToolResultActivity('file.patch', 'completed', {
                structuredOutput: { kind: 'file_patch', appliedFiles: ['a.ts', 'b.ts'] },
            }),
        ).toBe('Applied patch: a.ts, b.ts');
    });

    it('formats generic model output as compact success', () => {
        expect(
            formatToolResultActivity('glob', 'completed', {
                modelOutput: 'apps/cli/src/a.ts\napps/cli/src/b.ts\n',
            }),
        ).toContain('✓ glob:');
    });
});
