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
        expect(typedBlockPanelSource).not.toContain("border={['left']}");
        expect(typedBlockPanelSource).not.toContain('backgroundColor={CHAT_PANEL_BG}');
        expect(typedBlockPanelSource).not.toContain('paddingTop={CHAT_USER_PAD_Y}');
        expect(typedBlockPanelSource).not.toContain('paddingLeft={CHAT_USER_PAD_X}');
        expect(typedBlockPanelSource).not.toContain('gap={CHAT_USER_MARGIN_TOP}');
        expect(typedBlockPanelSource).toContain('<text selectable flexGrow={1} fg={status().color}>');
        expect(diffViewSource).toContain(
            '<text selectable {...rowStyle} {...(span.inverse ? { inverse: true } : {})}>',
        );
    });

    it('keeps expanded typed tool and diff text selectable without changing visible cells', async () => {
        // Given: one expanded multiline typed tool row and one nonempty typed diff row.
        // Native <diff> does not expose body glyphs as TextRenderable plainText; select the tool body.
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
            const frameBeforeSelection = setup.captureCharFrame();

            // When: the tool body line is selected through the native headless mouse path.
            await setup.mockMouse.drag(toolBody.x, toolBody.y, toolBody.x + 6, toolBody.y);
            await setup.renderOnce();

            // Then: tool/diff header seams stay selectable, selection is exact, and cells are unchanged.
            expect([toolTitle, toolBody, diffTitle].every((renderable) => renderable.selectable)).toBe(true);
            expect(setup.renderer.getSelection()?.getSelectedText()).toBe('second');
            expect(setup.captureCharFrame()).toBe(frameBeforeSelection);
            // Diff panel is expanded (not header-only): body slot reserved under the title.
            expect(frameBeforeSelection).toContain('Diff: src/selection.ts');
            const headerOnly = await testRender(
                () => (
                    <TypedDiffRow
                        part={{
                            id: 'diff-selection',
                            type: 'diff',
                            filePath: 'src/selection.ts',
                            text: '+diff selection text',
                        }}
                        expanded={false}
                    />
                ),
                { width: 80, height: 12 },
            );
            try {
                await headerOnly.renderOnce();
                expect(setup.captureCharFrame()).not.toBe(headerOnly.captureCharFrame());
            } finally {
                headerOnly.renderer.destroy();
            }
        } finally {
            setup.renderer.destroy();
        }
    });

    it('keeps retained semantic diff expanded when chip flag is collapsed without re-emission', async () => {
        // Given: one semantic diff retained while chip expand (Ctrl+O) is collapsed.
        // toolOutputExpanded is chip-only; typed body rows always expand (lifecycle gates still apply).
        const store = createChatStore();
        if (store.getSnapshot().toolOutputExpanded) {
            store.toggleToolOutputExpanded();
        }
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

        // When: the part is rendered with the chip flag collapsed vs forced header-only.
        const chipCollapsed = await testRender(
            () => (
                <TranscriptPartRenderer
                    part={retainedPart}
                    showThinking={true}
                    toolOutputExpanded={false}
                    transcriptParts={[retainedPart]}
                    viewportColumns={80}
                    isFirst={true}
                    isLast={true}
                />
            ),
            { width: 80, height: 8 },
        );
        const headerOnly = await testRender(
            () => (
                <TypedDiffRow
                    part={{
                        id: 'retained-diff',
                        type: 'diff',
                        filePath: 'src/retained.ts',
                        text: '+retained semantic diff',
                        status: 'completed',
                    }}
                    expanded={false}
                />
            ),
            { width: 80, height: 8 },
        );

        try {
            await chipCollapsed.renderOnce();
            await headerOnly.renderOnce();

            // Then: chip-collapsed render matches expanded body structure, not header-only; no re-emission.
            const chipFrame = chipCollapsed.captureCharFrame();
            const headerFrame = headerOnly.captureCharFrame();
            expect(chipFrame).toContain('Diff: src/retained.ts');
            expect(chipFrame).not.toBe(headerFrame);
            expect(store.getSnapshot().transcriptParts.at(0)).toBe(retainedPart);
            expect(emitTranscriptPart).toHaveBeenCalledTimes(1);
        } finally {
            emitTranscriptPart.mockRestore();
            chipCollapsed.renderer.destroy();
            headerOnly.renderer.destroy();
        }
    });
});
