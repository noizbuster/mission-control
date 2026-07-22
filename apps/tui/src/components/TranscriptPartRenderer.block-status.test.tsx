/** @jsxImportSource @opentui/solid */

import { type Renderable, RGBA, TextRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { TranscriptPart } from '../state/transcript-part';
import { terminalDisplayWidth } from '../terminal-text';
import { CHAT_ERROR, CHAT_SUCCESS, CHAT_WARNING } from './chat-theme';
import { TranscriptPartRenderer } from './TranscriptPartRenderer';

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

function expectFrameFits72Columns(frame: string): void {
    for (const line of frame.split('\n')) {
        expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(72);
    }
}

describe('TranscriptPartRenderer typed block status', () => {
    it('updates a same-ID diff suffix glyph and color without prepending lifecycle text or remounting', async () => {
        // Given: a mounted diff preview whose stable ID remains active across a status settlement.
        const partId = 'stable-interrupted-diff';
        const [part, setPart] = createSignal<TranscriptPart>({
            id: partId,
            type: 'diff',
            filePath: '현재-상태.txt',
            text: '-previous\n+current',
            status: 'running',
        });
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TranscriptPartRenderer
                        part={part()}
                        showThinking={true}
                        toolOutputExpanded={true}
                        transcriptParts={[part()]}
                        viewportColumns={72}
                        isFirst={true}
                        isLast={true}
                    />
                </box>
            ),
            { width: 72, height: 8 },
        );

        try {
            await setup.renderOnce();
            const parent = setup.renderer.root.getChildren().at(0);
            if (parent === undefined) {
                throw new Error('Expected the mounted transcript parent');
            }
            const runningHeader = 'Diff: 현재-상태.txt [~]';
            expect(setup.captureCharFrame()).toContain(runningHeader);
            expect(
                textByPlainText(collectTextRenderables(setup.renderer.root), runningHeader).fg.equals(
                    RGBA.fromHex(CHAT_WARNING),
                ),
            ).toBe(true);

            // When: the same typed diff is interrupted rather than remounted as another transcript row.
            setPart({
                id: partId,
                type: 'diff',
                filePath: '현재-상태.txt',
                text: '-previous\n+current',
                status: 'interrupted',
            });
            await setup.renderOnce();

            // Then: semantic color changes in place while the title remains bare before its suffix glyph.
            const interruptedHeader = 'Diff: 현재-상태.txt [x]';
            const frame = setup.captureCharFrame();
            expect(frame).not.toContain('Running');
            expect(frame).not.toContain('Interrupted');
            expect(frame).not.toContain('[~]');
            expect(frame).toContain('[x]');
            expect(frame).toContain(interruptedHeader);
            expect(
                textByPlainText(collectTextRenderables(setup.renderer.root), interruptedHeader).fg.equals(
                    RGBA.fromHex(CHAT_WARNING),
                ),
            ).toBe(true);
            expect(setup.renderer.root.getChildren().at(0)).toBe(parent);
            expectFrameFits72Columns(frame);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('renders running, completed, and failed bare titles with suffix glyphs and semantic status colors', async () => {
        // Given: completed and failed typed code blocks next to a statusless diff control.
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TranscriptPartRenderer
                        part={{
                            id: 'running-code',
                            type: 'code',
                            filePath: 'src/running.ts',
                            text: 'const running = true;',
                            status: 'running',
                        }}
                        showThinking={true}
                        toolOutputExpanded={true}
                        transcriptParts={[]}
                        viewportColumns={72}
                        isFirst={true}
                        isLast={false}
                    />
                    <TranscriptPartRenderer
                        part={{
                            id: 'completed-code',
                            type: 'code',
                            filePath: 'src/complete.ts',
                            text: 'const complete = true;',
                            status: 'completed',
                        }}
                        showThinking={true}
                        toolOutputExpanded={true}
                        transcriptParts={[
                            {
                                id: 'completed-code',
                                type: 'code',
                                filePath: 'src/complete.ts',
                                text: 'const complete = true;',
                                status: 'completed',
                            },
                        ]}
                        viewportColumns={72}
                        isFirst={false}
                        isLast={false}
                    />
                    <TranscriptPartRenderer
                        part={{
                            id: 'failed-code',
                            type: 'code',
                            filePath: 'src/failure.ts',
                            text: 'throw new Error();',
                            status: 'failed',
                        }}
                        showThinking={true}
                        toolOutputExpanded={true}
                        transcriptParts={[
                            {
                                id: 'failed-code',
                                type: 'code',
                                filePath: 'src/failure.ts',
                                text: 'throw new Error();',
                                status: 'failed',
                            },
                        ]}
                        viewportColumns={72}
                        isFirst={false}
                        isLast={false}
                    />
                    <TranscriptPartRenderer
                        part={{
                            id: 'neutral-diff',
                            type: 'diff',
                            filePath: 'src/neutral.ts',
                            text: '+neutral',
                        }}
                        showThinking={true}
                        toolOutputExpanded={true}
                        transcriptParts={[
                            {
                                id: 'neutral-diff',
                                type: 'diff',
                                filePath: 'src/neutral.ts',
                                text: '+neutral',
                            },
                        ]}
                        viewportColumns={72}
                        isFirst={false}
                        isLast={true}
                    />
                </box>
            ),
            { width: 72, height: 18 },
        );

        try {
            await setup.renderOnce();

            // When: typed code and diff blocks render through their shared panel.
            const frame = setup.captureCharFrame();
            const renderables = collectTextRenderables(setup.renderer.root);
            const runningHeader = 'Code: src/running.ts [~]';
            const completedHeader = 'Code: src/complete.ts [+]';
            const failedHeader = 'Code: src/failure.ts [!]';

            // Then: titles remain bare before a suffix glyph while status colors remain semantic.
            expect(frame).toContain(runningHeader);
            expect(frame).toContain(completedHeader);
            expect(frame).toContain(failedHeader);
            expect(frame).toContain('Diff: src/neutral.ts');
            expect(frame).not.toMatch(/(?:Running|Completed|Failed|Interrupted):/u);
            expect(frame).toContain('[~]');
            expect(frame).toContain('[+]');
            expect(frame).toContain('[!]');
            expect(textByPlainText(renderables, runningHeader).fg.equals(RGBA.fromHex(CHAT_WARNING))).toBe(true);
            expect(textByPlainText(renderables, completedHeader).fg.equals(RGBA.fromHex(CHAT_SUCCESS))).toBe(true);
            expect(textByPlainText(renderables, failedHeader).fg.equals(RGBA.fromHex(CHAT_ERROR))).toBe(true);
            expect(textByPlainText(renderables, 'Diff: src/neutral.ts').plainText).toBe('Diff: src/neutral.ts');
            expectFrameFits72Columns(frame);
        } finally {
            setup.renderer.destroy();
        }
    });
});
