import { afterEach, describe, expect, it } from 'vitest';
import { prepareSessionCompaction, projectApprovalContinuationMessages } from './desktop-approval-transcript.js';
import { JsonlSessionEventStore } from './memory/jsonl-session-event-store.js';
import {
    compacted,
    envelope,
    fixedCompactionNow,
    promptPromoted,
    providerCompleted,
    sessionCompactionTestSessionId as sessionId,
    validReplayContents,
} from './session-compaction-test-support.js';
import { projectJsonlSessionReplayPrefix } from './session-replay.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session compaction', () => {
    it('writes a durable compaction event into the JSONL session log', async () => {
        const dataDir = await tempRoot('mctrl-core-compaction-');
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir, now: fixedCompactionNow });

        try {
            await store.append(promptPromoted('input_1', 'message_1', 'first prompt'));

            const event = await store.compact({
                sessionId,
                timestamp: '2026-06-13T02:00:00.000Z',
                message: 'compacted older history',
                summary: 'summary text',
                boundaryEntryId: 'event_3',
                firstKeptEntryId: 'event_1',
                boundarySequence: 3,
                firstKeptSequence: 1,
            });

            expect(event).toMatchObject({
                type: 'session.compacted',
                sessionTree: {
                    kind: 'compaction',
                    summary: 'summary text',
                    boundarySequence: 3,
                    firstKeptSequence: 1,
                },
            });
        } finally {
            await store.close();
        }

        const replay = projectJsonlSessionReplayPrefix({
            sessionId,
            contents: await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8'),
        });

        expect(replay.projection.sessionTree.compactionBoundaries).toEqual([
            expect.objectContaining({
                summary: 'summary text',
                boundarySequence: 3,
                firstKeptSequence: 1,
            }),
        ]);
    });

    it('projects conversation context before and after a compaction boundary', () => {
        const before = projectApprovalContinuationMessages(
            [
                promptPromoted('input_1', 'message_1', 'task A'),
                providerCompleted('task A finished'),
                promptPromoted('input_2', 'message_2', 'task B'),
                providerCompleted('task B finished'),
            ],
            sessionId,
        );
        const after = projectApprovalContinuationMessages(
            [
                promptPromoted('input_1', 'message_1', 'task A'),
                providerCompleted('task A finished'),
                promptPromoted('input_2', 'message_2', 'task B'),
                providerCompleted('task B finished'),
                compacted('summary for task A', 2, 3),
                promptPromoted('input_3', 'message_3', 'task C'),
                providerCompleted('task C finished'),
            ],
            sessionId,
        );

        expect(before).toEqual([
            { role: 'user', content: 'task A' },
            { role: 'assistant', content: 'task A finished' },
            { role: 'user', content: 'task B' },
            { role: 'assistant', content: 'task B finished' },
        ]);
        expect(after).toEqual([
            {
                role: 'user',
                content: 'Session memory summary (untrusted, model-generated):\nsummary for task A',
            },
            { role: 'user', content: 'task B' },
            { role: 'assistant', content: 'task B finished' },
            { role: 'user', content: 'task C' },
            { role: 'assistant', content: 'task C finished' },
        ]);
    });

    it('redacts secret-like compaction summaries before storing and projecting them', async () => {
        const dataDir = await tempRoot('mctrl-core-compaction-redaction-');
        const secret = 'sk-proj-compactionSecret1234567890';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir, now: fixedCompactionNow });

        try {
            await store.append(promptPromoted('input_1', 'message_1', `keep ${secret} out of memory`));
            const event = await store.compact({
                sessionId,
                timestamp: '2026-06-13T02:00:00.000Z',
                message: 'compacted older history',
                summary: `Authorization: Bearer ${secret}\napi_key=${secret}\n-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
                boundaryEntryId: 'event_3',
                firstKeptEntryId: 'event_1',
                boundarySequence: 3,
                firstKeptSequence: 1,
            });

            expect(JSON.stringify(event)).not.toContain(secret);
            expect(event).toMatchObject({
                sessionTree: {
                    kind: 'compaction',
                    summary: expect.stringContaining('[REDACTED_CREDENTIAL]'),
                },
            });
        } finally {
            await store.close();
        }

        const replay = projectJsonlSessionReplayPrefix({
            sessionId,
            contents: await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8'),
        });
        const messages = projectApprovalContinuationMessages(replay.projection.events, sessionId);

        expect(JSON.stringify(replay.projection.sessionTree.compactionBoundaries)).not.toContain(secret);
        expect(JSON.stringify(messages)).not.toContain(secret);
        expect(messages).toContainEqual(
            expect.objectContaining({
                role: 'user',
                content: expect.stringContaining('Session memory summary (untrusted, model-generated):'),
            }),
        );
    });

    it('denies compaction for too-small and corrupt sessions', () => {
        const tooSmallReplay = projectJsonlSessionReplayPrefix({
            sessionId,
            contents: validReplayContents([
                envelope(0, promptPromoted('input_1', 'message_1', 'task A')),
                envelope(1, providerCompleted('task A finished')),
            ]),
        });
        const corruptReplay = projectJsonlSessionReplayPrefix({
            sessionId,
            contents: validReplayContents(
                [
                    envelope(0, promptPromoted('input_1', 'message_1', 'task A')),
                    envelope(2, providerCompleted('task A finished')),
                    envelope(1, promptPromoted('input_2', 'message_2', 'task B')),
                ],
                false,
            ),
        });

        expect(prepareSessionCompaction({ sessionId, replay: tooSmallReplay })).toMatchObject({
            status: 'denied',
            reason: 'too_small',
        });
        expect(prepareSessionCompaction({ sessionId, replay: corruptReplay })).toMatchObject({
            status: 'denied',
            reason: 'corrupt',
        });
    });

    it('prepares summary input from only the compacted prefix', () => {
        const replay = projectJsonlSessionReplayPrefix({
            sessionId,
            contents: validReplayContents([
                envelope(0, promptPromoted('input_1', 'message_1', 'task A')),
                envelope(1, providerCompleted('task A finished')),
                envelope(2, promptPromoted('input_2', 'message_2', 'task B')),
                envelope(3, providerCompleted('task B finished')),
                envelope(4, promptPromoted('input_3', 'message_3', 'task C')),
                envelope(5, providerCompleted('task C finished')),
            ]),
        });

        const preparation = prepareSessionCompaction({ sessionId, replay });
        if (preparation.status !== 'ready') {
            throw new Error('expected compaction preparation to be ready');
        }

        expect(preparation.summaryMessages).toEqual([
            { role: 'user', content: 'task A' },
            { role: 'assistant', content: 'task A finished' },
        ]);
        expect(preparation.visibleMessages).toEqual([
            { role: 'user', content: 'task A' },
            { role: 'assistant', content: 'task A finished' },
            { role: 'user', content: 'task B' },
            { role: 'assistant', content: 'task B finished' },
            { role: 'user', content: 'task C' },
            { role: 'assistant', content: 'task C finished' },
        ]);
    });
});

async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}
