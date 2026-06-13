import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from './jsonl-session-event-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('JsonlSessionEventStore envelope validation', () => {
    it('rejects explicit durable envelopes that bypass the next sequence or session id', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_envelope_validation';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });

        try {
            // When
            const skippedSequence = store.appendEnvelope({
                eventId: 'event_skipped_sequence',
                sequence: 1,
                createdAt: '2026-06-04T10:00:00.000Z',
                sessionId,
                durability: 'durable',
                event: sessionStartedEvent(sessionId),
            });
            const wrongSession = store.appendEnvelope({
                eventId: 'event_wrong_session',
                sequence: 0,
                createdAt: '2026-06-04T10:00:00.000Z',
                sessionId: 'session_jsonl_other',
                durability: 'durable',
                event: sessionStartedEvent('session_jsonl_other'),
            });

            // Then
            await expect(skippedSequence).rejects.toMatchObject({
                code: 'invalid_sequence',
                sessionId,
            });
            await expect(wrongSession).rejects.toMatchObject({
                code: 'session_mismatch',
                sessionId,
            });
        } finally {
            await store.close();
        }
    });
});

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-jsonl-validation-'));
    tempDirs.push(dataDir);
    return dataDir;
}

function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: '2026-06-04T10:00:00.000Z',
        sessionId,
        nativeSidecarStatus: 'mock',
    };
}
