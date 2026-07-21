/** @jsxImportSource @opentui/solid */

import { type Renderable, TextRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { TranscriptPart } from '../state/transcript-part';
import { TranscriptPartRenderer } from './TranscriptPartRenderer';

const PAST_MSG = 'msg-past';
const ACTIVE_MSG = 'msg-active';

function collectTextRenderables(renderable: Renderable): readonly TextRenderable[] {
    const children = renderable.getChildren().flatMap(collectTextRenderables);
    return renderable instanceof TextRenderable ? [renderable, ...children] : children;
}

function plainTexts(root: Renderable): readonly string[] {
    return collectTextRenderables(root).map((node) => node.plainText);
}

function pastTurnParts(): readonly TranscriptPart[] {
    return [
        {
            id: 'asst-past',
            type: 'assistant',
            text: 'past assistant prose',
            messageId: PAST_MSG,
            status: 'completed',
        },
        {
            id: 'tool-ok',
            type: 'inline-tool',
            text: 'successful-past-tool-body',
            toolName: 'repo.read',
            messageId: PAST_MSG,
            status: 'completed',
        },
        {
            id: 'tool-fail',
            type: 'inline-tool',
            text: 'failed-past-tool-body',
            toolName: 'file.edit',
            messageId: PAST_MSG,
            status: 'failed',
        },
        {
            id: 'diff-ok',
            type: 'diff',
            text: '+past-diff-line',
            filePath: 'src/past.ts',
            messageId: PAST_MSG,
            status: 'completed',
        },
    ];
}

function activeTurnParts(): readonly TranscriptPart[] {
    return [
        {
            id: 'asst-active',
            type: 'assistant',
            text: 'active assistant prose',
            messageId: ACTIVE_MSG,
            status: 'streaming',
        },
        {
            id: 'tool-active',
            type: 'inline-tool',
            text: 'active-tool-body',
            toolName: 'repo.read',
            messageId: ACTIVE_MSG,
            status: 'completed',
        },
    ];
}

describe('TranscriptPartRenderer footer + past-tool hide wire', () => {
    it('shows footer on past assistant and hides successful past tools while keeping failed tools', async () => {
        // Given: a settled past turn with successful tool, failed tool, and successful diff.
        const parts = pastTurnParts();
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    {parts.map((part, index) => (
                        <TranscriptPartRenderer
                            part={part}
                            showThinking={true}
                            toolOutputExpanded={false}
                            transcriptParts={parts}
                            viewportColumns={100}
                            isFirst={index === 0}
                            isLast={index === parts.length - 1}
                            activeAssistantMessageId={ACTIVE_MSG}
                        />
                    ))}
                </box>
            ),
            { width: 100, height: 24 },
        );

        try {
            // When: the past turn renders while another message is active.
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            const texts = plainTexts(setup.renderer.root).join('\n');

            // Then: footer chip + Element A appear; successful tool/diff hide; failed tool stays.
            // Markdown assistant prose may not paint glyphs into captureCharFrame; assert footer/tool seams.
            expect(frame).toContain('1 tools');
            expect(frame).toContain('1 failed');
            expect(frame).toContain('[+]');
            expect(texts).toContain('repo.read ×1');
            expect(frame).not.toContain('successful-past-tool-body');
            expect(frame).not.toContain('Diff: src/past.ts');
            expect(frame).toContain('failed-past-tool-body');
        } finally {
            setup.renderer.destroy();
        }
    });

    it('does not render footer on the active assistant turn', async () => {
        // Given: the currently streaming assistant turn with a completed tool satellite.
        const parts = activeTurnParts();
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    {parts.map((part, index) => (
                        <TranscriptPartRenderer
                            part={part}
                            showThinking={true}
                            toolOutputExpanded={false}
                            transcriptParts={parts}
                            viewportColumns={100}
                            isFirst={index === 0}
                            isLast={index === parts.length - 1}
                            activeAssistantMessageId={ACTIVE_MSG}
                        />
                    ))}
                </box>
            ),
            { width: 100, height: 16 },
        );

        try {
            // When: the active turn renders.
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            const texts = plainTexts(setup.renderer.root).join('\n');

            // Then: no footer chip/summary; active tool body remains visible (not past-hidden).
            // Tool status headers may use [+]/ assert footer-specific markers only.
            expect(texts).not.toContain('tools ·');
            expect(texts).not.toMatch(/\d+ tools/);
            expect(texts).not.toMatch(/\[\+\]$/m);
            expect(texts).not.toContain(' · [+]');
            expect(texts).not.toContain(' · [-]');
            expect(frame).toContain('active-tool-body');
            expect(frame).toContain('Completed: repo.read');
        } finally {
            setup.renderer.destroy();
        }
    });

    it('toggles only the footer expanded prop when toolOutputExpanded flips', async () => {
        // Given: a past assistant with one successful tool and a live chip-expand flag.
        const parts = pastTurnParts().slice(0, 2);
        const [expanded, setExpanded] = createSignal(false);
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    {parts.map((part, index) => (
                        <TranscriptPartRenderer
                            part={part}
                            showThinking={true}
                            toolOutputExpanded={expanded()}
                            transcriptParts={parts}
                            viewportColumns={100}
                            isFirst={index === 0}
                            isLast={index === parts.length - 1}
                            activeAssistantMessageId={ACTIVE_MSG}
                        />
                    ))}
                </box>
            ),
            { width: 100, height: 20 },
        );

        try {
            // When: Ctrl+O equivalent flips the chip flag.
            await setup.renderOnce();
            const collapsed = setup.captureCharFrame();
            setExpanded(true);
            await setup.renderOnce();
            const opened = setup.captureCharFrame();
            const openedTexts = plainTexts(setup.renderer.root).join('\n');

            // Then: collapsed shows [+]; expanded shows [-] and per-tool breakdown; tool body stays hidden.
            expect(collapsed).toContain('[+]');
            expect(collapsed).not.toContain('[-]');
            expect(opened).toContain('[-]');
            expect(openedTexts).toContain('repo.read  ×1');
            expect(collapsed).not.toContain('successful-past-tool-body');
            expect(opened).not.toContain('successful-past-tool-body');
        } finally {
            setup.renderer.destroy();
        }
    });
});
