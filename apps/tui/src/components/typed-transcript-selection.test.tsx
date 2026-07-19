/** @jsxImportSource @opentui/solid */

import { createChatStore } from '@mission-control/tui/state';
import { type Renderable, TextRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptPartRenderer } from './TranscriptPartRenderer';
import { TypedDiffRow, TypedToolRow } from './TypedTranscriptRows';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function sourceFor(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function collectTextRenderables(renderable: Renderable): readonly TextRenderable[] {
    const children = renderable.getChildren().flatMap(collectTextRenderables);
    return renderable instanceof TextRenderable ? [renderable, ...children] : children;
}

function textByPlainText(renderables: readonly TextRenderable[], plainText: string): TextRenderable {
    const match = renderables.find((renderable) => renderable.plainText === plainText);
    if (match === undefined) {
        throw new Error(`Missing text renderable: ${plainText}`);
    }
    return match;
}

describe('typed transcript selection contract', () => {
    it('declares every typed tool and diff text seam selectable in source', () => {
        // Given: the source modules that define typed transcript tool and diff text.
        const toolCardSource = sourceFor('./ToolCard.tsx');
        const typedRowsSource = sourceFor('./TypedTranscriptRows.tsx');
        const typedBlockPanelSource = sourceFor('./TypedBlockPanel.tsx');
        const diffViewSource = sourceFor('./diff/DiffView.tsx');

        // When: the text renderable declarations are inspected.
        const toolHeaders = toolCardSource.match(
            /<text selectable flexGrow=\{1\} fg=\{status\(\).color\}>\s*\{header\(\)\}\s*<\/text>/g,
        );

        // Then: collapsed/expanded headers, prose rows, typed titles, and every diff span state selection explicitly.
        expect(toolHeaders).toHaveLength(2);
        expect(toolCardSource).toMatch(/<text selectable fg=\{CHAT_TEXT\}>\s*\{line\}\s*<\/text>/);
        expect(typedRowsSource).toContain('<TypedBlockPanel');
        expect(typedBlockPanelSource).toContain('const status = () => toolStatusPresentation(props.status);');
        expect(typedBlockPanelSource).toContain('<text selectable flexGrow={1} fg={status().color}>');
        expect(diffViewSource).toContain(
            '<text selectable {...rowStyle} {...(span.inverse ? { inverse: true } : {})}>',
        );
    });

    it('keeps expanded typed tool and diff text selectable without changing visible cells', async () => {
        // Given: one expanded multiline typed tool row and one nonempty typed diff row.
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TypedToolRow
                        part={{
                            id: 'tool-selection',
                            type: 'block-tool',
                            title: 'file.edit',
                            text: 'first tool line\nsecond tool line',
                        }}
                        expanded={true}
                    />
                    <TypedDiffRow
                        part={{
                            id: 'diff-selection',
                            type: 'diff',
                            filePath: 'src/selection.ts',
                            text: '+diff selection text',
                        }}
                        expanded={true}
                    />
                </box>
            ),
            { width: 80, height: 12 },
        );

        try {
            await setup.renderOnce();
            const textRenderables = collectTextRenderables(setup.renderer.root);
            const toolTitle = textByPlainText(textRenderables, 'file.edit');
            const toolBody = textByPlainText(textRenderables, 'second tool line');
            const diffTitle = textByPlainText(textRenderables, 'Diff: src/selection.ts');
            const diffText = textByPlainText(textRenderables, '+diff selection text');
            const frameBeforeSelection = setup.captureCharFrame();

            // When: the diff line is selected through the native headless mouse path.
            await setup.mockMouse.drag(diffText.x, diffText.y, diffText.x + 5, diffText.y);
            await setup.renderOnce();

            // Then: every rendered typed text seam is selectable, selection is exact, and cells are unchanged.
            expect([toolTitle, toolBody, diffTitle, diffText].every((renderable) => renderable.selectable)).toBe(true);
            expect(setup.renderer.getSelection()?.getSelectedText()).toBe('+diff');
            expect(setup.captureCharFrame()).toBe(frameBeforeSelection);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('reveals one retained semantic part after expansion without another emission', async () => {
        // Given: one semantic diff emitted while the store preference is collapsed.
        const store = createChatStore();
        store.toggleToolOutputExpanded();
        const emitTranscriptPart = vi.spyOn(store, 'emitTranscriptPart');
        store.emitTranscriptPart(
            {
                id: 'retained-diff',
                type: 'diff',
                filePath: 'src/retained.ts',
                text: '+retained semantic diff',
                status: 'completed',
            },
            '',
        );
        const retainedPart = store.getSnapshot().transcriptParts.at(0);
        if (retainedPart === undefined) throw new Error('Expected retained transcript part');
        const collapsedSetup = await testRender(
            () => (
                <TranscriptPartRenderer
                    part={retainedPart}
                    showThinking={true}
                    toolOutputExpanded={store.getSnapshot().toolOutputExpanded}
                    viewportColumns={80}
                    isFirst={true}
                    isLast={true}
                />
            ),
            { width: 80, height: 8 },
        );

        try {
            await collapsedSetup.renderOnce();
            const collapsedText = collectTextRenderables(collapsedSetup.renderer.root).map(
                (renderable) => renderable.plainText,
            );
            expect(collapsedText).toContain('[+] Completed: Diff: src/retained.ts');
            expect(collapsedText).not.toContain('+retained semantic diff');
        } finally {
            collapsedSetup.renderer.destroy();
        }

        // When: only the visibility preference changes before the next TUI render.
        store.toggleToolOutputExpanded();
        const expandedSetup = await testRender(
            () => (
                <TranscriptPartRenderer
                    part={retainedPart}
                    showThinking={true}
                    toolOutputExpanded={store.getSnapshot().toolOutputExpanded}
                    viewportColumns={80}
                    isFirst={true}
                    isLast={true}
                />
            ),
            { width: 80, height: 8 },
        );

        try {
            await expandedSetup.renderOnce();

            // Then: the original part body appears and no producer emission was needed.
            const expandedText = collectTextRenderables(expandedSetup.renderer.root).map(
                (renderable) => renderable.plainText,
            );
            expect(expandedText).toContain('+retained semantic diff');
            expect(store.getSnapshot().transcriptParts.at(0)).toBe(retainedPart);
            expect(emitTranscriptPart).toHaveBeenCalledTimes(1);
        } finally {
            emitTranscriptPart.mockRestore();
            expandedSetup.renderer.destroy();
        }
    });
});
