/** @jsxImportSource @opentui/solid */

import { testRender } from '@opentui/solid';
import { type JSX, onMount } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { ClipboardServiceRenderer } from '../platform/clipboard-service';
import { MissionControlClipboardToastProviders, useTuiToast } from '../platform/providers/clipboard-toast-context';
import { Toast } from './Toast';

const TEST_ROWS = 12;
const TOAST_MESSAGE = '中断した作業を安全に停止しています。Ctrl+Cをもう一度押すと終了します。詳細を保存しています。';

const testClipboardRenderer: ClipboardServiceRenderer = {
    copyToClipboardOSC52(): boolean {
        return false;
    },
    isOsc52Supported(): boolean {
        return false;
    },
};

function ToastScenario(): JSX.Element {
    const toast = useTuiToast();
    onMount(() => {
        toast.show({ message: TOAST_MESSAGE, variant: 'info', duration: 60_000 });
    });
    return <Toast />;
}

function transcriptBehindToast(columns: number): string {
    const row = `${' '.repeat(columns - 2)}t`;
    return Array.from({ length: TEST_ROWS }, () => row).join('\n');
}

function toastRows(frame: string): readonly string[] {
    return frame.split('\n').filter((row) => row.includes('│') || row.includes('┐') || row.includes('┘'));
}

async function expectToastToCoverRightGutter(columns: number): Promise<void> {
    const setup = await testRender(
        () => (
            <box width="100%" height={TEST_ROWS} position="relative">
                <text>{transcriptBehindToast(columns)}</text>
                <MissionControlClipboardToastProviders useRenderer={() => testClipboardRenderer}>
                    <ToastScenario />
                </MissionControlClipboardToastProviders>
            </box>
        ),
        { width: columns, height: TEST_ROWS },
    );

    try {
        await setup.renderOnce();
        const coveredRows = toastRows(setup.captureCharFrame());

        expect(coveredRows).not.toHaveLength(0);
        expect(coveredRows.map((row) => row.slice(columns - 2, columns - 1))).toContain('t');
    } finally {
        setup.renderer.destroy();
    }
}

describe('Toast mounted layout', () => {
    it('covers the 72-column right gutter over transcript text', async () => {
        // Given: the fresh interrupt width and an underlying transcript marker at column 71.
        // When: a long CJK toast is mounted over the transcript.
        await expectToastToCoverRightGutter(72);

        // Then: every toast-border row masks the marker immediately beside the former right gutter.
    });

    it('covers the right gutter at a narrower supported width', async () => {
        // Given: a narrower terminal with the same visible transcript marker.
        // When: the same long CJK toast is mounted.
        await expectToastToCoverRightGutter(48);

        // Then: no toast-border row exposes the marker beside its right edge.
    });
});
