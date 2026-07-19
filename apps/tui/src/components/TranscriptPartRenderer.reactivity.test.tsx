/** @jsxImportSource @opentui/solid */

import { type Renderable, RGBA, TextRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { TranscriptPart } from '../state/transcript-part';
import { CHAT_TEXT } from './chat-theme';
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

describe('TranscriptPartRenderer mounted reactivity', () => {
    it('updates a mounted command status from Running to Interrupted without remounting its parent', async () => {
        // Given: one mounted current-turn command row with a stable transcript ID.
        const partId = 'stable-interrupted-command';
        const [part, setPart] = createSignal<TranscriptPart>({
            id: partId,
            type: 'command',
            command: 'pnpm typecheck',
            text: '$ pnpm typecheck',
            detail: '$ pnpm typecheck',
            status: 'running',
        });
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TranscriptPartRenderer
                        part={part()}
                        showThinking={true}
                        toolOutputExpanded={true}
                        viewportColumns={80}
                        isFirst={true}
                        isLast={true}
                    />
                </box>
            ),
            { width: 80, height: 8 },
        );

        try {
            await setup.renderOnce();
            const parent = setup.renderer.root.getChildren().at(0);
            if (parent === undefined) {
                throw new Error('Expected the mounted transcript parent');
            }
            expect(setup.captureCharFrame()).toContain('Running');

            // When: interruption upserts the same typed row with only its status changed.
            setPart({
                id: partId,
                type: 'command',
                command: 'pnpm typecheck',
                text: '$ pnpm typecheck',
                detail: '$ pnpm typecheck',
                status: 'interrupted',
            });
            await setup.renderOnce();

            // Then: the mounted row visibly settles while its parent and command metadata remain intact.
            const frame = setup.captureCharFrame();
            expect(frame).not.toContain('Running');
            expect(frame).toContain('Interrupted');
            expect(frame).toContain('pnpm typecheck');
            expect(setup.renderer.root.getChildren().at(0)).toBe(parent);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('replaces a same-ID diff preview with a plain command settlement without remounting its parent', async () => {
        // Given: one mounted diff row whose stable ID is reused by a command settlement.
        const partId = 'stable-settlement';
        const [part, setPart] = createSignal<TranscriptPart>({
            id: partId,
            type: 'diff',
            filePath: 'src/preview.ts',
            text: '-preview line\n+preview replacement',
        });
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TranscriptPartRenderer
                        part={part()}
                        showThinking={true}
                        toolOutputExpanded={true}
                        viewportColumns={80}
                        isFirst={true}
                        isLast={true}
                    />
                </box>
            ),
            { width: 80, height: 12 },
        );

        try {
            await setup.renderOnce();
            const parent = setup.renderer.root.getChildren().at(0);
            if (parent === undefined) {
                throw new Error('Expected the mounted transcript parent');
            }
            expect(setup.captureCharFrame()).toContain('+preview replacement');

            // When: the same stable transcript ID settles into command output containing diff-looking literals.
            setPart({
                id: partId,
                type: 'command',
                command: 'pnpm verify',
                text: '+stdout literal\n-stderr literal\n@@ hunk literal',
                status: 'completed',
            });
            await setup.renderOnce();

            // Then: the original preview is gone, the parent persists, and literals retain command-body styling.
            const textRenderables = collectTextRenderables(setup.renderer.root);
            const visibleText = textRenderables.map((renderable) => renderable.plainText);
            expect(setup.renderer.root.getChildren().at(0)).toBe(parent);
            expect(visibleText).not.toContain('+preview replacement');
            expect(visibleText).toEqual(
                expect.arrayContaining(['+stdout literal', '-stderr literal', '@@ hunk literal']),
            );
            for (const literal of ['+stdout literal', '-stderr literal', '@@ hunk literal']) {
                expect(textByPlainText(textRenderables, literal).fg.equals(RGBA.fromHex(CHAT_TEXT))).toBe(true);
            }
        } finally {
            setup.renderer.destroy();
        }
    });

    it('reveals a settled one-line subagent body after an active one-line tool with the same ID', async () => {
        // Given: an expanded active one-line tool row with a stable transcript ID.
        const partId = 'stable-one-line-settlement';
        const [part, setPart] = createSignal<TranscriptPart>({
            id: partId,
            type: 'inline-tool',
            title: 'repo.read',
            text: 'active one-line tool body',
            status: 'running',
        });
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TranscriptPartRenderer
                        part={part()}
                        showThinking={true}
                        toolOutputExpanded={true}
                        viewportColumns={80}
                        isFirst={true}
                        isLast={true}
                    />
                </box>
            ),
            { width: 80, height: 12 },
        );

        try {
            await setup.renderOnce();
            const parent = setup.renderer.root.getChildren().at(0);
            if (parent === undefined) {
                throw new Error('Expected the mounted transcript parent');
            }
            expect(setup.captureCharFrame()).not.toContain('active one-line tool body');

            // When: the same ID settles into a one-line subagent result.
            setPart({
                id: partId,
                type: 'subagent',
                agentName: 'reviewer',
                text: 'settled one-line subagent body',
                status: 'completed',
            });
            await setup.renderOnce();

            // Then: the settled body appears in the existing mounted transcript position.
            expect(setup.captureCharFrame()).toContain('settled one-line subagent body');
            expect(setup.renderer.root.getChildren().at(0)).toBe(parent);
        } finally {
            setup.renderer.destroy();
        }
    });
});
