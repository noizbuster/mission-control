/** @jsxImportSource @opentui/solid */

import { type Renderable, RGBA, TextRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { describe, expect, it } from 'vitest';
import type { TranscriptPart, TranscriptPartStatus } from '../state/transcript-part';
import {
    aggregateToolCallsForMessage,
    formatChipLabel,
    formatExpandedBreakdown,
    formatInlineSummary,
} from '../state/tool-call-aggregation';
import {
    AssistantMessageFooter,
    buildBreakdownRows,
    chipLabelSegments,
    shouldRenderAssistantMessageFooter,
} from './AssistantMessageFooter';
import { CHAT_ERROR, CHAT_SUCCESS, CHAT_TEXT_MUTED } from './chat-theme';

const MSG = 'msg-footer-1';

function toolPart(input: {
    readonly id: string;
    readonly status?: TranscriptPartStatus;
    readonly messageId?: string;
    readonly toolName?: string;
    readonly text?: string;
}): TranscriptPart {
    return {
        id: input.id,
        type: 'inline-tool',
        text: input.text ?? '',
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    };
}

function commandPart(input: {
    readonly id: string;
    readonly status?: TranscriptPartStatus;
    readonly messageId?: string;
    readonly toolName?: string;
    readonly exitCode?: number;
}): TranscriptPart {
    return {
        id: input.id,
        type: 'command',
        text: '',
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    };
}

function collectTextRenderables(renderable: Renderable): readonly TextRenderable[] {
    const children = renderable.getChildren().flatMap(collectTextRenderables);
    return renderable instanceof TextRenderable ? [renderable, ...children] : children;
}

function plainTexts(root: Renderable): readonly string[] {
    return collectTextRenderables(root).map((node) => node.plainText);
}

function frameHasText(frame: string, expected: string): boolean {
    return frame.replace(/\s+/g, ' ').includes(expected.replace(/\s+/g, ' '));
}

describe('shouldRenderAssistantMessageFooter', () => {
    it('is false when both counts are zero', () => {
        // Given: no settled tools for the message.
        const agg = aggregateToolCallsForMessage([], MSG);

        // When / Then: the footer must not mount.
        expect(shouldRenderAssistantMessageFooter(agg)).toBe(false);
    });

    it('is true when only failed tools exist', () => {
        const parts = [toolPart({ id: 't1', status: 'failed', messageId: MSG, toolName: 'write' })];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(shouldRenderAssistantMessageFooter(agg)).toBe(true);
        expect(agg.totalCount).toBe(0);
        expect(agg.failedCount).toBe(1);
    });
});

describe('chipLabelSegments', () => {
    it('keeps success-only chips fully muted and matches formatChipLabel', () => {
        const parts = [
            toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'read' }),
            toolPart({ id: 't2', status: 'completed', messageId: MSG, toolName: 'grep' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        const collapsed = chipLabelSegments(agg, false);
        const expanded = chipLabelSegments(agg, true);

        expect(collapsed.map((segment) => segment.text).join('')).toBe(formatChipLabel(agg, false));
        expect(expanded.map((segment) => segment.text).join('')).toBe(formatChipLabel(agg, true));
        expect(collapsed).toEqual([{ text: '2 tools · [+]', color: CHAT_TEXT_MUTED }]);
        expect(expanded).toEqual([{ text: '2 tools · [-]', color: CHAT_TEXT_MUTED }]);
    });

    it('colors the failed segment red in mixed and failed-only chips', () => {
        const mixed = aggregateToolCallsForMessage(
            [
                toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'read' }),
                toolPart({ id: 't2', status: 'denied', messageId: MSG, toolName: 'bash.run' }),
                toolPart({ id: 't3', status: 'cancelled', messageId: MSG, toolName: 'write' }),
            ],
            MSG,
        );
        expect(chipLabelSegments(mixed, false)).toEqual([
            { text: '1 tools · ', color: CHAT_TEXT_MUTED },
            { text: '2 failed', color: CHAT_ERROR },
            { text: ' · [+]', color: CHAT_TEXT_MUTED },
        ]);
        expect(chipLabelSegments(mixed, false).map((segment) => segment.text).join('')).toBe(
            formatChipLabel(mixed, false),
        );

        const failedOnly = aggregateToolCallsForMessage(
            [toolPart({ id: 't1', status: 'failed', messageId: MSG, toolName: 'edit' })],
            MSG,
        );
        expect(chipLabelSegments(failedOnly, true)).toEqual([
            { text: '1 failed', color: CHAT_ERROR },
            { text: ' · [-]', color: CHAT_TEXT_MUTED },
        ]);
    });
});

describe('buildBreakdownRows', () => {
    it('colors mutation deltas, exit codes, and the failed line', () => {
        const parts = [
            toolPart({
                id: 't1',
                status: 'completed',
                messageId: MSG,
                toolName: 'file.edit',
                text: '-a\n+b\n+c\n',
            }),
            commandPart({
                id: 'c1',
                status: 'completed',
                messageId: MSG,
                toolName: 'bash.run',
                exitCode: 0,
            }),
            commandPart({
                id: 'c2',
                status: 'completed',
                messageId: MSG,
                toolName: 'bash.run',
                exitCode: 1,
            }),
            toolPart({ id: 't2', status: 'failed', messageId: MSG, toolName: 'write' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        const rows = buildBreakdownRows(agg);
        const joined = rows.map((row) => row.segments.map((segment) => segment.text).join(''));

        // Plain formatter contract stays the source of truth for line text.
        expect(joined).toEqual([...formatExpandedBreakdown(agg)]);

        const editRow = rows[0];
        expect(editRow?.segments).toEqual([
            { text: 'file.edit  ×1', color: CHAT_TEXT_MUTED },
            { text: ' (', color: CHAT_TEXT_MUTED },
            { text: '+2', color: CHAT_SUCCESS },
            { text: ' ', color: CHAT_TEXT_MUTED },
            { text: '-1', color: CHAT_ERROR },
            { text: ')', color: CHAT_TEXT_MUTED },
        ]);

        const bashRow = rows[1];
        expect(bashRow?.segments).toEqual([
            { text: 'bash.run  ×2', color: CHAT_TEXT_MUTED },
            { text: ' (exit ', color: CHAT_TEXT_MUTED },
            { text: '0', color: CHAT_TEXT_MUTED },
            { text: '/', color: CHAT_TEXT_MUTED },
            { text: '1', color: CHAT_ERROR },
            { text: ')', color: CHAT_TEXT_MUTED },
        ]);

        const failedRow = rows[2];
        expect(failedRow?.segments).toEqual([
            { text: '⚠ failed ×1', color: CHAT_ERROR },
        ]);
    });
});

describe('AssistantMessageFooter mounted', () => {
    it('renders nothing when there are zero tools', async () => {
        // Given: no aggregatable settled tools for the message.
        const setup = await testRender(
            () => <AssistantMessageFooter messageId={MSG} parts={[]} expanded={false} />,
            { width: 48, height: 4 },
        );

        try {
            // When: the footer mounts with an empty aggregate.
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            // Then: no Element A/B content is painted.
            expect(frame.trim()).toBe('');
            expect(plainTexts(setup.renderer.root).join('')).toBe('');
        } finally {
            setup.renderer.destroy();
        }
    });

    it('shows Element A matching formatInlineSummary and a collapsed chip', async () => {
        // Given: two successful tools on one past assistant message.
        const parts = [
            toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'read' }),
            toolPart({ id: 't2', status: 'completed', messageId: MSG, toolName: 'grep' }),
            toolPart({ id: 't3', status: 'completed', messageId: MSG, toolName: 'read' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        const expectedSummary = formatInlineSummary(agg);
        const expectedChip = formatChipLabel(agg, false);

        const setup = await testRender(
            () => <AssistantMessageFooter messageId={MSG} parts={parts} expanded={false} />,
            { width: 72, height: 4 },
        );

        try {
            // When: the footer mounts collapsed.
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            const texts = plainTexts(setup.renderer.root);

            // Then: Element A matches the pure formatter and the chip is collapsed.
            expect(expectedSummary).toBe('read ×2 · grep ×1');
            expect(agg.totalCount).toBe(3);
            expect(expectedChip).toBe('3 tools · [+]');
            expect(texts).toContain(expectedSummary);
            expect(texts.join('')).toContain(expectedChip);
            expect(frameHasText(frame, expectedSummary)).toBe(true);
            expect(frameHasText(frame, expectedChip)).toBe(true);
            expect(frame).not.toContain('⚠ failed');
            expect(
                collectTextRenderables(setup.renderer.root)
                    .find((node) => node.plainText === expectedSummary)
                    ?.fg.equals(RGBA.fromHex(CHAT_TEXT_MUTED)),
            ).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('expanded shows breakdown including the failed line when failedCount > 0', async () => {
        // Given: mixed success + failed tools with mutation and exit metadata.
        const parts = [
            toolPart({
                id: 't1',
                status: 'completed',
                messageId: MSG,
                toolName: 'file.edit',
                text: '-old\n+new\n',
            }),
            toolPart({ id: 't2', status: 'completed', messageId: MSG, toolName: 'repo.read' }),
            commandPart({
                id: 'c1',
                status: 'completed',
                messageId: MSG,
                toolName: 'bash.run',
                exitCode: 1,
            }),
            toolPart({ id: 't3', status: 'failed', messageId: MSG, toolName: 'write' }),
            toolPart({ id: 't4', status: 'denied', messageId: MSG, toolName: 'patch' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        const expectedLines = formatExpandedBreakdown(agg);
        const expectedChip = formatChipLabel(agg, true);

        const setup = await testRender(
            () => <AssistantMessageFooter messageId={MSG} parts={parts} expanded={true} />,
            { width: 80, height: 10 },
        );

        try {
            // When: the footer mounts expanded.
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            const texts = plainTexts(setup.renderer.root);
            const joined = texts.join('');

            // Then: chip is expanded, breakdown lines match the pure formatter, failed line is present.
            expect(expectedChip).toBe('3 tools · 2 failed · [-]');
            expect(joined).toContain(expectedChip.replaceAll(' · ', ' · '));
            for (const line of expectedLines) {
                expect(joined).toContain(line);
                expect(frameHasText(frame, line)).toBe(true);
            }
            expect(expectedLines.at(-1)).toBe('⚠ failed ×2');
            expect(
                collectTextRenderables(setup.renderer.root)
                    .find((node) => node.plainText === '⚠ failed ×2')
                    ?.fg.equals(RGBA.fromHex(CHAT_ERROR)),
            ).toBe(true);
            expect(
                collectTextRenderables(setup.renderer.root)
                    .find((node) => node.plainText === '2 failed')
                    ?.fg.equals(RGBA.fromHex(CHAT_ERROR)),
            ).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('failed-only messages omit Element A and still show the failed chip', async () => {
        // Given: only failed tools (no successful tally for Element A).
        const parts = [
            toolPart({ id: 't1', status: 'failed', messageId: MSG, toolName: 'write' }),
            toolPart({ id: 't2', status: 'interrupted', messageId: MSG, toolName: 'edit' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);

        const setup = await testRender(
            () => <AssistantMessageFooter messageId={MSG} parts={parts} expanded={false} />,
            { width: 48, height: 4 },
        );

        try {
            await setup.renderOnce();
            const texts = plainTexts(setup.renderer.root);
            const joined = texts.join('');

            expect(formatInlineSummary(agg)).toBe('');
            expect(joined).not.toMatch(/×\d/);
            expect(joined).toContain('2 failed');
            expect(joined).toContain('[+]');
        } finally {
            setup.renderer.destroy();
        }
    });
});
