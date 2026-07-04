import { describe, expect, it } from 'vitest';
import { darkTheme, noColorTheme } from '../components/markdown/theme.js';
import { RESET, TEXT_DANGER_BOLD } from './ansi-theme.js';
import { joinBlocks, renderBlock } from './block-renderer.js';
import type { OutputBlock } from './output-blocks.js';

const ttyOpts = { width: 80, tty: true, thinking: true, theme: darkTheme } as const;
const noTtyOpts = { width: 80, tty: false, thinking: true, theme: noColorTheme } as const;

describe('renderBlock - session-header', () => {
    it('renders a \\n> line with provider . model', () => {
        const block: OutputBlock = { kind: 'session-header', providerID: 'openai', modelID: 'gpt-5' };
        const out = renderBlock(block, ttyOpts);
        expect(out.startsWith('\n> ')).toBe(true);
        expect(out).toContain('openai');
        expect(out).toContain('gpt-5');
        expect(out).toContain('\u00b7');
    });

    it('appends #variant when variantID is present', () => {
        const block: OutputBlock = {
            kind: 'session-header',
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variantID: 'thinking-high',
        };
        const out = renderBlock(block, ttyOpts);
        expect(out).toContain('#thinking-high');
    });
});

describe('renderBlock - assistant-text', () => {
    it('renders markdown via renderMarkdownAnsi wrapped in blank lines', () => {
        const block: OutputBlock = { kind: 'assistant-text', text: '# Hi\n\nA paragraph.' };
        const out = renderBlock(block, ttyOpts);
        expect(out.startsWith('\n')).toBe(true);
        expect(out.endsWith('\n')).toBe(true);
        expect(out).toContain('Hi');
        expect(out).toContain('A paragraph.');
    });
});

describe('renderBlock - tool', () => {
    it('renders read-class tool as ONE inline line containing the gear and tool name', () => {
        const block: OutputBlock = {
            kind: 'tool',
            toolCallId: 't1',
            toolName: 'read',
            argumentsJson: '{"path":"/foo/bar.ts"}',
            status: 'completed',
        };
        const out = renderBlock(block, ttyOpts);
        expect(out).toContain('\u2699 read');
        expect(out).toContain('/foo/bar.ts');
        const contentLines = out.split('\n').filter((l) => l !== '');
        expect(contentLines).toHaveLength(1);
    });

    it('renders file.patch as a multi-line expanded block with output body', () => {
        const block: OutputBlock = {
            kind: 'tool',
            toolCallId: 't2',
            toolName: 'file.patch',
            argumentsJson: '{}',
            status: 'completed',
            output: '--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new',
        };
        const out = renderBlock(block, ttyOpts);
        expect(out).toContain('\u2699 file.patch');
        expect(out).toContain('--- a/foo');
        const contentLines = out.split('\n').filter((l) => l !== '');
        expect(contentLines.length).toBeGreaterThan(1);
    });
});

describe('renderBlock - reasoning', () => {
    it('returns empty string when thinking is false', () => {
        const block: OutputBlock = { kind: 'reasoning', text: 'Let me think about this...' };
        const out = renderBlock(block, { ...ttyOpts, thinking: false });
        expect(out).toBe('');
    });

    it('renders a dimmed+italic block when thinking is true', () => {
        const block: OutputBlock = { kind: 'reasoning', text: 'Step by step reasoning.' };
        const out = renderBlock(block, ttyOpts);
        expect(out).not.toBe('');
        expect(out).toContain('Step by step reasoning.');
        // darkTheme.quote = { italic: true, dim: true }; dim=SGR2, italic=SGR3
        expect(out).toContain('\x1b[2m');
        expect(out).toContain('\x1b[3m');
        expect(out).toContain(RESET);
    });
});

describe('renderBlock - error', () => {
    it('renders Error: styled with danger bold', () => {
        const block: OutputBlock = { kind: 'error', message: 'Something went wrong' };
        const out = renderBlock(block, ttyOpts);
        expect(out).toContain('Error:');
        expect(out).toContain('Something went wrong');
        expect(out).toContain(TEXT_DANGER_BOLD);
        expect(out).toContain(RESET);
    });
});

describe('renderBlock - non-TTY', () => {
    it('emits ZERO \\x1b bytes across all block kinds while preserving structure', () => {
        const blocks: OutputBlock[] = [
            { kind: 'session-header', providerID: 'openai', modelID: 'gpt-5' },
            { kind: 'reasoning', text: 'chain of thought' },
            { kind: 'assistant-text', text: '# Hello\n\nA paragraph.' },
            {
                kind: 'tool',
                toolCallId: 't1',
                toolName: 'read',
                argumentsJson: '{"path":"/f.ts"}',
                status: 'completed',
            },
            {
                kind: 'tool',
                toolCallId: 't2',
                toolName: 'file.patch',
                argumentsJson: '{}',
                status: 'completed',
                output: 'patch body',
            },
            { kind: 'error', message: 'boom' },
        ];
        const rendered = blocks.map((b) => renderBlock(b, noTtyOpts));
        const joined = joinBlocks(rendered);
        expect(joined.includes('\x1b')).toBe(false);
        expect(joined).toContain('> openai');
        expect(joined).toContain('Hello');
        expect(joined).toContain('\u2699 read');
        expect(joined).toContain('\u2699 file.patch');
        expect(joined).toContain('Error:');
    });
});

describe('renderBlock - malformed input (adversarial: malformed_input)', () => {
    it('renders a non-read tool with empty output as a header-only block', () => {
        const block: OutputBlock = {
            kind: 'tool',
            toolCallId: 't3',
            toolName: 'file.write',
            argumentsJson: '{}',
            status: 'completed',
        };
        const out = renderBlock(block, ttyOpts);
        expect(out).toContain('\u2699 file.write');
    });

    it('renders an error block with an empty message without throwing', () => {
        const block: OutputBlock = { kind: 'error', message: '' };
        expect(() => renderBlock(block, ttyOpts)).not.toThrow();
        const out = renderBlock(block, ttyOpts);
        expect(out).toContain('Error:');
    });
});

describe('joinBlocks', () => {
    it('collapses 3+ consecutive newlines into at most one blank line', () => {
        const joined = joinBlocks(['\n> header\n', '\nbody line one\nbody line two\n', '\ntail\n']);
        expect(joined).not.toMatch(/\n{3,}/);
    });

    it('drops empty (suppressed) block strings', () => {
        const joined = joinBlocks(['\nfirst\n', '', '\nsecond\n']);
        expect(joined).toContain('first');
        expect(joined).toContain('second');
        expect(joined).not.toMatch(/\n{3,}/);
    });
});
