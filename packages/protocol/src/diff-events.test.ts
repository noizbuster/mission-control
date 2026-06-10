import { describe, expect, it } from 'vitest';
import { DiffFileSchema, DiffHunkSchema } from './diff-events.js';
import { AgentEventSchema } from './schema.js';

describe('diff event protocol schemas', () => {
    it('parses file diffs and rejects malformed diff hunks', () => {
        const fileDiff = DiffFileSchema.parse({
            filePath: 'packages/protocol/src/provider-events.ts',
            changeKind: 'modified',
            hunks: [
                {
                    oldStart: 1,
                    oldLines: 2,
                    newStart: 1,
                    newLines: 3,
                    lines: [
                        {
                            kind: 'context',
                            content: 'export const existing = true;',
                        },
                        {
                            kind: 'removed',
                            content: 'export const oldValue = true;',
                        },
                        {
                            kind: 'added',
                            content: 'export const newValue = true;',
                        },
                    ],
                },
            ],
        });
        const malformedHunk = DiffHunkSchema.safeParse({
            oldStart: 0,
            oldLines: -1,
            newStart: 1,
            newLines: 1,
            lines: [],
        });

        expect(fileDiff.hunks[0]?.lines[2]?.kind).toBe('added');
        expect(malformedHunk.success).toBe(false);
    });

    it('parses replayable file diff agent events', () => {
        const event = AgentEventSchema.parse({
            type: 'file.diff.applied',
            timestamp: '2026-06-09T00:00:00.000Z',
            taskId: 'tool_patch',
            message: 'patch applied',
            nativeSidecarStatus: 'mock',
            diffFiles: [
                {
                    filePath: 'packages/core/src/tools/file-patch.ts',
                    changeKind: 'modified',
                    hunks: [
                        {
                            oldStart: 1,
                            oldLines: 1,
                            newStart: 1,
                            newLines: 1,
                            lines: [
                                { kind: 'removed', content: 'old' },
                                { kind: 'added', content: '[REDACTED_CREDENTIAL]', redacted: true },
                            ],
                        },
                    ],
                },
            ],
        });

        expect(event.diffFiles?.[0]?.filePath).toBe('packages/core/src/tools/file-patch.ts');
        expect(event.diffFiles?.[0]?.hunks[0]?.lines[1]?.redacted).toBe(true);
    });
});
