import { describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from './jsonl-session-event-store';
import {
    createTempDataDir,
    envelopeSequence,
    readJsonlRecords,
    sessionStartedEvent,
    taskCompletedEvent,
} from './jsonl-session-event-store-test-support';
import { join } from 'node:path';

describe('JsonlSessionEventStore replay and sequence', () => {
    it('replays durable events in order after the writer is reopened', async () => {
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_replay';
        const firstStore = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const started = sessionStartedEvent(sessionId);
        const completed = taskCompletedEvent(sessionId);
        await firstStore.append(started);
        await firstStore.append(completed);
        await firstStore.close();

        const reopened = await JsonlSessionEventStore.open({ sessionId, dataDir });
        const events = await reopened.getEvents(sessionId);
        const snapshot = await reopened.getSnapshot(sessionId);
        await reopened.close();

        expect(events).toEqual([started, completed]);
        expect(snapshot).toMatchObject({
            sessionId,
            completedTaskCount: 1,
            lastMessage: 'completed from jsonl',
        });
    });

    it('serializes concurrent append calls with monotonic event sequences', async () => {
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_concurrent_append';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        await Promise.all([store.append(sessionStartedEvent(sessionId)), store.append(taskCompletedEvent(sessionId))]);
        await store.close();
        const records = await readJsonlRecords(join(dataDir, 'sessions', `${sessionId}.jsonl`));

        expect(records.slice(1).map((record) => envelopeSequence(record))).toEqual([0, 1]);
    });
});
