import { type DiffFile, DiffFileSchema } from '@mission-control/protocol';
import { expect, it, vi } from 'vitest';

const boundingWork = vi.hoisted(() => ({ cumulativeInputBytes: 0 }));

vi.mock('./interactive-coding-file-write-preview', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./interactive-coding-file-write-preview')>();
    return {
        ...actual,
        boundFileWriteDisplayBody(text: string, originalBytes?: number) {
            boundingWork.cumulativeInputBytes += Buffer.byteLength(text, 'utf8');
            return actual.boundFileWriteDisplayBody(text, originalBytes);
        },
    };
});

import { projectFileResultParts } from './interactive-coding-file-transcript';

it('keeps cumulative byte-bounding input near-linear when short diff line count doubles', () => {
    // Given
    const smallerDiff = shortLineDiff(256);
    const largerDiff = shortLineDiff(512);

    // When
    const smallerInputBytes = measureBoundingInput(smallerDiff);
    const largerInputBytes = measureBoundingInput(largerDiff);

    // Then
    expect(
        largerInputBytes,
        `doubling short diff lines increased cumulative bounding input from ${smallerInputBytes} to ${largerInputBytes} bytes`,
    ).toBeLessThanOrEqual(smallerInputBytes * 3);
});

function shortLineDiff(lineCount: number): DiffFile {
    return DiffFileSchema.parse({
        filePath: 'many-short-lines.txt',
        changeKind: 'modified',
        hunks: [
            {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: lineCount,
                lines: Array.from({ length: lineCount }, () => ({ kind: 'added', content: 'x' })),
            },
        ],
    });
}

function measureBoundingInput(file: DiffFile): number {
    boundingWork.cumulativeInputBytes = 0;
    projectFileResultParts({
        toolBaseId: 'tool:complexity',
        toolCallId: 'write-complexity',
        structuredOutput: { diffFiles: [file] },
        events: [],
    });
    return boundingWork.cumulativeInputBytes;
}
