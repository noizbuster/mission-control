/** @jsxImportSource @opentui/solid */

import { testRender } from '@opentui/solid';
import { describe, expect, it } from 'vitest';
import { TranscriptPartRenderer } from './TranscriptPartRenderer';
import { TypedCodeRow, TypedDiffRow, TypedSubagentRow, TypedToolRow } from './TypedTranscriptRows';

describe('typed transcript lifecycle expansion', () => {
    it('shows every tool and subagent body when expanded', async () => {
        // Given: expanded tool and subagent rows spanning active/settled and one-line/multiline states.
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TypedToolRow
                        part={{
                            id: 'tool-active-one',
                            type: 'block-tool',
                            title: 'tool-active-one',
                            text: 'tool-active-one-body',
                            status: 'running',
                        }}
                        expanded={true}
                        viewportColumns={120}
                    />
                    <TypedToolRow
                        part={{
                            id: 'tool-active-many',
                            type: 'block-tool',
                            title: 'tool-active-many',
                            text: 'tool-active-many-first\ntool-active-many-last',
                            status: 'running',
                        }}
                        expanded={true}
                        viewportColumns={120}
                    />
                    <TypedToolRow
                        part={{
                            id: 'tool-settled-one',
                            type: 'block-tool',
                            title: 'tool-settled-one',
                            text: 'tool-settled-one-body',
                            status: 'completed',
                        }}
                        expanded={true}
                        viewportColumns={120}
                    />
                    <TypedToolRow
                        part={{
                            id: 'tool-settled-many',
                            type: 'block-tool',
                            title: 'tool-settled-many',
                            text: 'tool-settled-many-first\ntool-settled-many-last',
                            status: 'completed',
                        }}
                        expanded={true}
                        viewportColumns={120}
                    />
                    <TypedSubagentRow
                        part={{
                            id: 'subagent-active-one',
                            type: 'subagent',
                            agentName: 'subagent-active-one',
                            text: 'subagent-active-one-body',
                            status: 'running',
                        }}
                        expanded={true}
                    />
                    <TypedSubagentRow
                        part={{
                            id: 'subagent-active-many',
                            type: 'subagent',
                            agentName: 'subagent-active-many',
                            text: 'subagent-active-many-first\nsubagent-active-many-last',
                            status: 'running',
                        }}
                        expanded={true}
                    />
                    <TypedSubagentRow
                        part={{
                            id: 'subagent-settled-one',
                            type: 'subagent',
                            agentName: 'subagent-settled-one',
                            text: 'subagent-settled-one-body',
                            status: 'completed',
                        }}
                        expanded={true}
                    />
                    <TypedSubagentRow
                        part={{
                            id: 'subagent-settled-many',
                            type: 'subagent',
                            agentName: 'subagent-settled-many',
                            text: 'subagent-settled-many-first\nsubagent-settled-many-last',
                            status: 'completed',
                        }}
                        expanded={true}
                    />
                </box>
            ),
            { width: 80, height: 40 },
        );

        try {
            // When: the expanded rows are mounted into the OpenTUI renderer.
            await setup.renderOnce();

            // Then: row expansion controls all tool and subagent bodies uniformly.
            const frame = setup.captureCharFrame();
            expect(frame).toContain('tool-active-one-body');
            expect(frame).toContain('tool-active-many-last');
            expect(frame).toContain('tool-settled-one-body');
            expect(frame).toContain('tool-settled-many-last');
            expect(frame).toContain('subagent-active-one-body');
            expect(frame).toContain('subagent-active-many-last');
            expect(frame).toContain('subagent-settled-one-body');
            expect(frame).toContain('subagent-settled-many-last');
        } finally {
            setup.renderer.destroy();
        }
    });

    it('toggles active multiline tool/code/diff bodies with the Ctrl+O output state', async () => {
        // Given: identical active tool rows rendered with each Ctrl+O output state.
        // Native <diff>/<Markdown> may not paint body glyphs into captureCharFrame; assert
        // tool body text plus code/diff panel structure matching expanded=true (not header-only).
        const chipCollapsed = await testRender(
            () => (
                <box flexDirection="column">
                    <TranscriptPartRenderer
                        part={{
                            id: 'tool-active-many',
                            type: 'block-tool',
                            title: 'tool-active-many',
                            text: 'tool-active-many-first\ntool-active-many-last',
                            status: 'running',
                        }}
                        showThinking={true}
                        toolOutputExpanded={false}
                        transcriptParts={[]}
                        viewportColumns={80}
                        isFirst={true}
                        isLast={false}
                    />
                    <TranscriptPartRenderer
                        part={{
                            id: 'code-active-many',
                            type: 'code',
                            text: 'const a = 1;\nconst b = 2;',
                            language: 'ts',
                            status: 'running',
                        }}
                        showThinking={true}
                        toolOutputExpanded={false}
                        transcriptParts={[]}
                        viewportColumns={80}
                        isFirst={false}
                        isLast={false}
                    />
                    <TranscriptPartRenderer
                        part={{
                            id: 'diff-active-many',
                            type: 'diff',
                            filePath: 'src/active.ts',
                            text: '-old line\n+new line',
                            status: 'running',
                        }}
                        showThinking={true}
                        toolOutputExpanded={false}
                        transcriptParts={[]}
                        viewportColumns={80}
                        isFirst={false}
                        isLast={true}
                    />
                </box>
            ),
            { width: 80, height: 30 },
        );
        const chipExpanded = await testRender(
            () => (
                <box flexDirection="column">
                    <TranscriptPartRenderer
                        part={{
                            id: 'tool-active-many',
                            type: 'block-tool',
                            title: 'tool-active-many',
                            text: 'tool-active-many-first\ntool-active-many-last',
                            status: 'running',
                        }}
                        showThinking={true}
                        toolOutputExpanded={true}
                        transcriptParts={[]}
                        viewportColumns={80}
                        isFirst={true}
                        isLast={false}
                    />
                    <TranscriptPartRenderer
                        part={{
                            id: 'code-active-many',
                            type: 'code',
                            text: 'const a = 1;\nconst b = 2;',
                            language: 'ts',
                            status: 'running',
                        }}
                        showThinking={true}
                        toolOutputExpanded={true}
                        transcriptParts={[]}
                        viewportColumns={80}
                        isFirst={false}
                        isLast={false}
                    />
                    <TranscriptPartRenderer
                        part={{
                            id: 'diff-active-many',
                            type: 'diff',
                            filePath: 'src/active.ts',
                            text: '-old line\n+new line',
                            status: 'running',
                        }}
                        showThinking={true}
                        toolOutputExpanded={true}
                        transcriptParts={[]}
                        viewportColumns={80}
                        isFirst={false}
                        isLast={true}
                    />
                </box>
            ),
            { width: 80, height: 30 },
        );
        // Header-only baseline: row-level expanded=false collapses TypedBlockPanel bodies.
        const headerOnly = await testRender(
            () => (
                <box flexDirection="column">
                    <TypedToolRow
                        part={{
                            id: 'tool-active-many',
                            type: 'block-tool',
                            title: 'tool-active-many',
                            text: 'tool-active-many-first\ntool-active-many-last',
                            status: 'running',
                        }}
                        expanded={false}
                        viewportColumns={120}
                    />
                    <TypedCodeRow
                        part={{
                            id: 'code-active-many',
                            type: 'code',
                            text: 'const a = 1;\nconst b = 2;',
                            language: 'ts',
                            status: 'running',
                        }}
                        expanded={false}
                        viewportColumns={80}
                    />
                    <TypedDiffRow
                        part={{
                            id: 'diff-active-many',
                            type: 'diff',
                            filePath: 'src/active.ts',
                            text: '-old line\n+new line',
                            status: 'running',
                        }}
                        expanded={false}
                    />
                </box>
            ),
            { width: 80, height: 30 },
        );

        try {
            // When: the same parts render with chip flag false, chip flag true, and forced header-only.
            await chipCollapsed.renderOnce();
            await chipExpanded.renderOnce();
            await headerOnly.renderOnce();
            const collapsedFrame = chipCollapsed.captureCharFrame();
            const expandedFrame = chipExpanded.captureCharFrame();
            const headerOnlyFrame = headerOnly.captureCharFrame();

            // Then: the collapsed output state matches header-only content, while expanded reveals bodies.
            expect(collapsedFrame).not.toContain('tool-active-many-last');
            expect(expandedFrame).toContain('tool-active-many-last');
            expect(collapsedFrame).toBe(headerOnlyFrame);
            expect(expandedFrame).not.toBe(headerOnlyFrame);
            expect(expandedFrame).toContain('Code (ts)');
            expect(expandedFrame).toContain('Diff: src/active.ts');
        } finally {
            chipCollapsed.renderer.destroy();
            chipExpanded.renderer.destroy();
            headerOnly.renderer.destroy();
        }
    });
});
