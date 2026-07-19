import { AgentEventSchema, type DiffFile, DiffFileSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectFileResultParts } from './interactive-coding-file-transcript';
import { FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES } from './interactive-coding-file-write-preview';

const timestamp = '2026-07-18T00:00:00.000Z';
const credential = 'sk-filewritebody123';
const redactedCredential = '[REDACTED_CREDENTIAL]';

describe('bounded file.write settlement transcript projection', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('preserves a normal structured diff body exactly', () => {
        // Given
        const file = DiffFileSchema.parse({
            filePath: 'notes.txt',
            changeKind: 'modified',
            hunks: [
                {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: [
                        { kind: 'removed', content: 'before' },
                        { kind: 'added', content: 'after' },
                    ],
                },
            ],
        });

        // When
        const parts = projectFileResultParts({
            toolBaseId: 'tool:normal',
            toolCallId: 'write-normal',
            structuredOutput: { diffFiles: [file] },
            events: [],
        });

        // Then
        expect(parts).toEqual([
            expect.objectContaining({
                id: 'tool:normal:result:0',
                type: 'diff',
                text: ['--- a/notes.txt', '+++ b/notes.txt', '@@ -1,1 +1,1 @@', '-before', '+after'].join('\n'),
                status: 'completed',
            }),
        ]);
    });

    it('bounds an oversized structured diff without JSON serialization or parsing', () => {
        // Given
        const fixture = oversizedDiffFixture('STRUCTURED_TAIL_SENTINEL');
        const parse = vi.spyOn(JSON, 'parse');
        const stringify = vi.spyOn(JSON, 'stringify');

        // When
        const parts = projectFileResultParts({
            toolBaseId: 'tool:structured',
            toolCallId: 'write-structured',
            structuredOutput: { diffFiles: [fixture.file] },
            events: [],
        });

        // Then
        expect(parts).toHaveLength(1);
        expectBoundedBody(parts[0]?.text, fixture.expectedOriginalBytes, fixture.tail);
        expect(parse).not.toHaveBeenCalled();
        expect(stringify).not.toHaveBeenCalled();
    });

    it.each([
        { eventType: 'file.diff.proposed', expectedStatus: 'pending' },
        { eventType: 'file.diff.applied', expectedStatus: 'completed' },
    ] as const)('bounds an oversized $eventType event body', ({ eventType, expectedStatus }) => {
        // Given
        const fixture = oversizedDiffFixture(`${eventType}_TAIL_SENTINEL`);
        const event = AgentEventSchema.parse({
            type: eventType,
            timestamp,
            taskId: `write-${eventType}`,
            message: eventType,
            nativeSidecarStatus: 'mock',
            diffFiles: [fixture.file],
        });

        // When
        const parts = projectFileResultParts({
            toolBaseId: `tool:${eventType}`,
            toolCallId: `write-${eventType}`,
            structuredOutput: undefined,
            events: [event],
        });

        // Then
        expect(parts[0]).toEqual(expect.objectContaining({ status: expectedStatus }));
        expectBoundedBody(parts[0]?.text, fixture.expectedOriginalBytes, fixture.tail);
    });
});

type OversizedDiffFixture = {
    readonly file: DiffFile;
    readonly expectedOriginalBytes: number;
    readonly tail: string;
};

function oversizedDiffFixture(tail: string): OversizedDiffFixture {
    const retainedPrefix = `credential ${credential}\n${'한'.repeat(FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES)}`;
    const content = `${retainedPrefix}🙂${tail}`;
    const file = DiffFileSchema.parse({
        filePath: 'oversized.txt',
        changeKind: 'modified',
        hunks: [
            {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [{ kind: 'added', content }],
            },
        ],
    });
    const rendered = [
        '--- a/oversized.txt',
        '+++ b/oversized.txt',
        '@@ -1,1 +1,1 @@',
        `+${content.replace(credential, redactedCredential)}`,
    ].join('\n');
    return { file, expectedOriginalBytes: Buffer.byteLength(rendered, 'utf8'), tail };
}

function expectBoundedBody(text: string | undefined, expectedOriginalBytes: number, tail: string): void {
    if (text === undefined) throw new Error('Expected one retained diff body');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES);
    expect(text).not.toContain(tail);
    expect(text).not.toContain(credential);
    expect(text).not.toContain('\uFFFD');
    expect(text).toContain(redactedCredential);

    const separator = text.indexOf('\n');
    const metadata = separator === -1 ? text : text.slice(0, separator);
    const body = separator === -1 ? '' : text.slice(separator + 1);
    const match = /^Diff body: (\d+)\/(\d+) bytes \(truncated\)$/u.exec(metadata);
    const returnedBytes = match?.[1];
    const originalBytes = match?.[2];
    if (returnedBytes === undefined || originalBytes === undefined) {
        throw new Error(`Expected explicit diff truncation metadata, received: ${metadata}`);
    }
    expect(Number(returnedBytes)).toBe(Buffer.byteLength(body, 'utf8'));
    expect(Number(originalBytes)).toBe(expectedOriginalBytes);
}
