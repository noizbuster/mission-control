/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from 'vitest';
import type { TranscriptPart } from '../state/transcript-part';
import { terminalDisplayWidth } from '../terminal-text';
import {
    buildFencedCodeMarkdown,
    isFinalLegacyPartStreaming,
    presentTranscriptPart,
    transcriptContentWidth,
} from './transcript-part-presentation';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ALL_PART_VARIANTS = [
    { id: 'user', type: 'user', text: '사용자 입력' },
    { id: 'assistant', type: 'assistant', text: 'assistant output', status: 'streaming' },
    { id: 'reasoning', type: 'reasoning', text: 'thinking output', status: 'completed' },
    { id: 'inline', type: 'inline-tool', text: 'repo.read', output: 'inline output', status: 'completed' },
    { id: 'block', type: 'block-tool', text: 'file.edit', output: 'block output', status: 'failed' },
    { id: 'diff', type: 'diff', text: '-oldValue\n+newValue', filePath: 'src/example.ts' },
    { id: 'code', type: 'code', text: 'const marker = "```";', language: 'ts', filePath: 'src/code.ts' },
    {
        id: 'command',
        type: 'command',
        text: 'pnpm test',
        detail: 'line one\nline two',
        exitCode: 1,
        status: 'failed',
    },
    {
        id: 'subagent',
        type: 'subagent',
        text: 'subagent completed',
        detail: 'full result',
        agentName: 'reviewer',
        sessionId: 'session-7',
        status: 'completed',
    },
    { id: 'status', type: 'status', text: 'status note', status: 'informational' },
    { id: 'event', type: 'event', text: 'event note', eventType: 'tool.completed', timestamp: '2026-07-17' },
    { id: 'error', type: 'error', text: 'failure text', error: 'EPIPE', code: 'EPIPE', status: 'failed' },
    { id: 'legacy', type: 'legacy', text: 'legacy text' },
] satisfies readonly TranscriptPart[];

describe('presentTranscriptPart', () => {
    it('presents every transcript variant with its semantic body intact', () => {
        // Given: one representative of every protocol-defined transcript part.
        const parts = ALL_PART_VARIANTS;

        // When: each part is converted into its renderer presentation.
        const presentations = parts.map(presentTranscriptPart);

        // Then: all variants survive exactly once with their text still available to the renderer.
        expect(parts).toHaveLength(13);
        expect(presentations.map((presentation) => presentation.type)).toEqual(parts.map((part) => part.type));
        const renderedContent = presentations.flatMap((presentation) => presentation.lines).join('\n');
        for (const part of parts) {
            expect(renderedContent).toContain(part.text);
        }
        expect(renderedContent).toContain('inline output');
        expect(renderedContent).toContain('block output');
        expect(renderedContent).toContain('line two');
        expect(renderedContent).toContain('full result');
        expect(renderedContent).toContain('EPIPE');
    });

    it('splits settled block-tool and subagent result text without duplicating matching detail', () => {
        // Given: settled production-shaped parts whose full result is already stored in text.
        const resultText = 'result line one\nresult line two';
        const parts = [
            {
                id: 'settled-block-tool',
                type: 'block-tool',
                text: resultText,
                detail: resultText,
                toolCallId: 'call-file-edit',
                toolName: 'file.edit',
                status: 'completed',
            },
            {
                id: 'settled-subagent',
                type: 'subagent',
                text: resultText,
                detail: resultText,
                agentName: 'reviewer',
                sessionId: 'session-42',
                status: 'completed',
            },
        ] satisfies readonly TranscriptPart[];

        // When: the settled transcript parts are converted to visual presentations.
        const lines = parts.map((part) => presentTranscriptPart(part).lines);

        // Then: primary result lines are ordered, duplicate detail is absent, and subagent metadata follows the body.
        expect(lines).toEqual([
            ['result line one', 'result line two'],
            ['result line one', 'result line two', 'Session: session-42'],
        ]);
    });

    it('keeps a 72-column CJK row whole while reserving a positive markdown width', () => {
        // Given: thirty-six Hangul glyphs, each occupying two terminal cells.
        const cjk72Columns = '가'.repeat(36);

        // When: the renderer reserves the established assistant inset.
        const width = transcriptContentWidth(72, 3);

        // Then: content width remains positive and no code-unit truncation changes the text.
        expect(terminalDisplayWidth(cjk72Columns)).toBe(72);
        expect(width).toBeGreaterThan(0);
        expect(presentTranscriptPart({ id: 'cjk', type: 'assistant', text: cjk72Columns }).lines).toEqual([
            cjk72Columns,
        ]);
    });
});

describe('typed legacy streaming ownership', () => {
    it('does not stream an intermediate legacy row while generation is active', () => {
        // Given: global generation with another transcript part following this legacy segment.
        const generating = true;
        const isLast = false;

        // When: the legacy row determines its own streaming state.
        const streaming = isFinalLegacyPartStreaming(generating, isLast);

        // Then: only the final row may use streaming markdown healing.
        expect(streaming).toBe(false);
    });

    it('streams the final legacy row while generation is active', () => {
        // Given: global generation and the final transcript row.
        const generating = true;
        const isLast = true;

        // When: the legacy row determines its own streaming state.
        const streaming = isFinalLegacyPartStreaming(generating, isLast);

        // Then: the active final row remains eligible for streaming rendering.
        expect(streaming).toBe(true);
    });
});

describe('buildFencedCodeMarkdown', () => {
    it('keeps ordinary code and its safe language metadata intact', () => {
        // Given: ordinary typed code and a single safe language token.
        const code = 'const answer = 42;';

        // When: the code is prepared for the existing Markdown pipeline.
        const markdown = buildFencedCodeMarkdown(code, 'typescript');

        // Then: a normal Markdown fence preserves both the language and every code byte.
        expect(markdown).toBe('```typescript\nconst answer = 42;\n```');
    });

    it('uses a fence longer than every backtick run in the code body', () => {
        // Given: code containing a four-backtick run.
        const code = 'before ``` middle ```` after';

        // When: the code is fenced for Markdown.
        const markdown = buildFencedCodeMarkdown(code, 'ts');

        // Then: the five-backtick delimiter cannot be terminated by the body and the body is exact.
        expect(markdown).toBe('`````ts\nbefore ``` middle ```` after\n`````');
    });

    it('omits injected language metadata without changing the code body', () => {
        // Given: a language value containing a newline and fence injection attempt.
        const code = 'let value = `safe`;';

        // When: the value is prepared for Markdown.
        const markdown = buildFencedCodeMarkdown(code, 'ts\n``` injected');

        // Then: the unsafe info string is omitted while the original code remains byte-exact.
        expect(markdown).toBe('```\nlet value = `safe`;\n```');
    });
});

describe('TranscriptPartRenderer component topology', () => {
    it('routes every variant through an exhaustive switch with reactive streaming, thinking, detail, and legacy seams', () => {
        // Given: the typed renderer source used by the OpenTUI component tree.
        const source = readFileSync(
            resolve(process.cwd(), 'apps/tui/src/components/TranscriptPartRenderer.tsx'),
            'utf8',
        );

        // When: its semantic routing topology is inspected without a native FFI renderer.
        const variantCases = ALL_PART_VARIANTS.map((part) => `case '${part.type}':`);

        // Then: every variant reaches a dedicated renderer and established interaction seams remain intact.
        for (const variantCase of variantCases) {
            expect(source).toContain(variantCase);
        }
        expect(source).toContain('return assertNever(props.part)');
        // Ctrl+O drives all tool-body expansion paths, with no footer-only bypass.
        expect(source).toContain('expanded={props.toolOutputExpanded}');
        expect(source).toContain('toolOutputExpanded={props.toolOutputExpanded}');
        expect(source).toContain('shouldHideToolPart');
        expect(source).toContain('transcriptParts={props.transcriptParts}');
        expect(source).toContain('viewportColumns={props.viewportColumns}');

        const rowsSource = readFileSync(
            resolve(process.cwd(), 'apps/tui/src/components/TypedTranscriptRows.tsx'),
            'utf8',
        );
        expect(rowsSource).toContain('isTranscriptPartStreaming(props.part.status)');
        expect(rowsSource).toContain('<Show when={props.showThinking}>');
        expect(rowsSource).toContain('<DiffView');
        expect(rowsSource).toContain('diff={props.part.text}');
        // Lifecycle gates still consume the row-level expanded prop.
        expect(rowsSource).toContain('expanded={props.expanded}');
        expect(rowsSource).toContain('parseMessageBlocks(props.part.text)');
        expect(rowsSource).not.toContain('AssistantMessageFooter');
        expect(rowsSource).not.toContain('attributionKeyForAssistantPart');

        const typedCodeRowSource = rowsSource.slice(
            rowsSource.indexOf('export function TypedCodeRow'),
            rowsSource.indexOf('export function TypedCommandRow'),
        );
        expect(typedCodeRowSource).toContain('<Markdown');
        expect(typedCodeRowSource).toContain('buildFencedCodeMarkdown(props.part.text, props.part.language)');
        expect(typedCodeRowSource).not.toContain('<For');

        const typedDiffRowSource = rowsSource.slice(
            rowsSource.indexOf('export function TypedDiffRow'),
            rowsSource.indexOf('export function TypedCodeRow'),
        );
        expect(typedDiffRowSource).toContain('diff={props.part.text}');
        expect(typedDiffRowSource).not.toContain('<ToolCard');

        const typedCommandRowSource = rowsSource.slice(
            rowsSource.indexOf('export function TypedCommandRow'),
            rowsSource.indexOf('export function TypedSubagentRow'),
        );
        expect(typedCommandRowSource).toContain('bodyMode="plain"');
        expect(rowsSource.match(/bodyMode="plain"/g)).toHaveLength(1);
    });
});
