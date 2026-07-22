/** @jsxImportSource @opentui/solid */

import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { TranscriptPart } from '../state/transcript-part';
import { ToolCard } from './ToolCard';
import { TranscriptPartRenderer } from './TranscriptPartRenderer';
import { TypedToolRow } from './TypedTranscriptRows';

function rowFor(frame: string, text: string): number {
    const row = frame.split('\n').findIndex((line) => line.includes(text));
    if (row === -1) throw new Error(`Missing frame text: ${text}`);
    return row;
}

describe('TranscriptPartRenderer tool output presentation', () => {
    it('renders a collapsed tool card with only its bare title and lifecycle suffix', async () => {
        const setup = await testRender(
            () => (
                <ToolCard
                    title="file.edit"
                    lines={['first output line', 'second output line']}
                    expanded={false}
                    status="completed"
                />
            ),
            { width: 100, height: 4 },
        );

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            expect(frame).toContain('file.edit [+]');
            expect(frame).not.toMatch(/\(\d+ lines?\)/u);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('keeps a successful past tool visible without assistant aggregate statistics', async () => {
        const part: TranscriptPart = {
            id: 'past-tool',
            type: 'block-tool',
            toolName: 'repo.read',
            text: 'past successful output',
            messageId: 'past-message',
            status: 'completed',
        };
        const setup = await testRender(
            () => (
                <TranscriptPartRenderer
                    part={part}
                    showThinking={true}
                    toolOutputExpanded={true}
                    transcriptParts={[part]}
                    viewportColumns={100}
                    isFirst={true}
                    isLast={true}
                    activeAssistantMessageId="active-message"
                />
            ),
            { width: 100, height: 8 },
        );

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            expect(frame).toContain('repo.read');
            expect(frame).toContain('past successful output');
            expect(frame).not.toMatch(/\d+ tools/u);
            expect(frame).not.toContain('×1');
        } finally {
            setup.renderer.destroy();
        }
    });

    it('toggles tool bodies with Ctrl+O output expansion', async () => {
        const part: TranscriptPart = {
            id: 'tool-toggle',
            type: 'block-tool',
            toolName: 'file.edit',
            text: 'toggle body',
            status: 'completed',
        };
        const [expanded, setExpanded] = createSignal(false);
        const setup = await testRender(
            () => (
                <TranscriptPartRenderer
                    part={part}
                    showThinking={true}
                    toolOutputExpanded={expanded()}
                    transcriptParts={[part]}
                    viewportColumns={100}
                    isFirst={true}
                    isLast={true}
                    activeAssistantMessageId="active-message"
                />
            ),
            { width: 100, height: 8 },
        );

        try {
            await setup.renderOnce();
            const collapsed = setup.captureCharFrame();
            setExpanded(true);
            await setup.renderOnce();
            const opened = setup.captureCharFrame();

            expect(collapsed).not.toContain('toggle body');
            expect(opened).toContain('toggle body');
            expect(collapsed).toContain('file.edit [+]');
            expect(opened).toContain('file.edit [+]');
        } finally {
            setup.renderer.destroy();
        }
    });

    it('places consecutive typed tools and parsed legacy tool receipts on adjacent frame rows', async () => {
        const legacyPart: TranscriptPart = {
            id: 'legacy-tools',
            type: 'legacy',
            text: 'tool: legacy-one\ntool: legacy-two',
        };
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TypedToolRow
                        part={{ id: 'typed-one', type: 'block-tool', toolName: 'typed-one', text: '' }}
                        expanded={false}
                    />
                    <TypedToolRow
                        part={{ id: 'typed-two', type: 'block-tool', toolName: 'typed-two', text: '' }}
                        expanded={false}
                    />
                    <TranscriptPartRenderer
                        part={legacyPart}
                        showThinking={true}
                        toolOutputExpanded={false}
                        transcriptParts={[legacyPart]}
                        viewportColumns={100}
                        isFirst={false}
                        isLast={true}
                    />
                </box>
            ),
            { width: 100, height: 10 },
        );

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            expect(rowFor(frame, 'typed-two') - rowFor(frame, 'typed-one')).toBe(1);
            expect(rowFor(frame, 'legacy-two') - rowFor(frame, 'legacy-one')).toBe(1);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('hides only typed aggregate status summaries', async () => {
        const summary: TranscriptPart = {
            id: 'summary',
            type: 'status',
            text: '✓ 2 tools (14ms)',
        };
        const receipt: TranscriptPart = {
            id: 'receipt',
            type: 'status',
            text: 'individual receipt remains',
        };
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TranscriptPartRenderer
                        part={summary}
                        showThinking={true}
                        toolOutputExpanded={false}
                        transcriptParts={[summary, receipt]}
                        viewportColumns={100}
                        isFirst={true}
                        isLast={false}
                    />
                    <TranscriptPartRenderer
                        part={receipt}
                        showThinking={true}
                        toolOutputExpanded={false}
                        transcriptParts={[summary, receipt]}
                        viewportColumns={100}
                        isFirst={false}
                        isLast={true}
                    />
                </box>
            ),
            { width: 100, height: 6 },
        );

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            expect(frame).not.toContain('✓ 2 tools');
            expect(frame).toContain('individual receipt remains');
        } finally {
            setup.renderer.destroy();
        }
    });
});
