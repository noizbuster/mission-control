import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionEventStore, JsonlSessionEventStoreError } from './jsonl-session-event-store.js';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('JsonlSessionEventStore', () => {
    it('creates a versioned header and appends durable event envelopes', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_header';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            now: () => '2026-06-04T10:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        // When
        await store.append(sessionStartedEvent(sessionId));
        await store.close();

        // Then
        const records = await readJsonlRecords(join(dataDir, 'sessions', `${sessionId}.jsonl`));
        expect(records).toHaveLength(2);
        expect(records.at(0)).toMatchObject({
            kind: 'mission-control.session-log',
            version: 1,
            sessionId,
            createdAt: '2026-06-04T10:00:00.000Z',
        });
        expect(records.at(1)).toMatchObject({
            kind: 'mission-control.session-event',
            version: 1,
            event: {
                eventId: 'event_0',
                sequence: 0,
                createdAt: '2026-06-04T10:00:00.000Z',
                sessionId,
                durability: 'durable',
                event: {
                    type: 'session.started',
                    sessionId,
                },
            },
        });
    });

    it('prevents concurrent writers from opening the same session log', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_lock';
        const firstStore = await JsonlSessionEventStore.open({ sessionId, dataDir });

        try {
            // When
            const secondOpen = JsonlSessionEventStore.open({ sessionId, dataDir });

            // Then
            await expect(secondOpen).rejects.toMatchObject({
                code: 'lock_exists',
                sessionId,
            });
        } finally {
            await firstStore.close();
        }
    });

    it('replays durable events in order after the writer is reopened', async () => {
        // Given
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

        // When
        const reopened = await JsonlSessionEventStore.open({ sessionId, dataDir });
        const events = await reopened.getEvents(sessionId);
        const snapshot = await reopened.getSnapshot(sessionId);
        await reopened.close();

        // Then
        expect(events).toEqual([started, completed]);
        expect(snapshot).toMatchObject({
            sessionId,
            completedTaskCount: 1,
            lastMessage: 'completed from jsonl',
        });
    });

    it('serializes concurrent append calls with monotonic event sequences', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_concurrent_append';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        // When
        await Promise.all([store.append(sessionStartedEvent(sessionId)), store.append(taskCompletedEvent(sessionId))]);
        await store.close();
        const records = await readJsonlRecords(join(dataDir, 'sessions', `${sessionId}.jsonl`));

        // Then
        expect(records.slice(1).map((record) => envelopeSequence(record))).toEqual([0, 1]);
    });

    it('reports corrupt line diagnostics with the session id and line number', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_corrupt';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });
        await store.close();
        await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"not valid json"\n', 'utf8');

        // When
        const openCorruptStore = JsonlSessionEventStore.open({ sessionId, dataDir });

        // Then
        await expect(openCorruptStore).rejects.toBeInstanceOf(JsonlSessionEventStoreError);
        await expect(openCorruptStore).rejects.toMatchObject({
            code: 'corrupt_line',
            sessionId,
            lineNumber: 2,
        });
    });
});

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-jsonl-'));
    tempDirs.push(dataDir);
    return dataDir;
}

async function readJsonlRecords(filePath: string): Promise<readonly Record<string, unknown>[]> {
    const contents = await readFile(filePath, 'utf8');
    return contents
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map(parseJsonRecord);
}

function parseJsonRecord(line: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
        throw new TypeError('JSONL line did not parse to an object');
    }
    return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

type JsonlRecordView = Record<string, unknown> & { readonly event?: unknown };

function envelopeSequence(record: JsonlRecordView): unknown {
    const event = eventEnvelopeFromRecord(record);
    return event?.sequence;
}

function eventEnvelopeFromRecord(record: JsonlRecordView): { readonly sequence?: unknown } | undefined {
    const event = record.event;
    return isRecord(event) ? event : undefined;
}

function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: '2026-06-04T10:00:00.000Z',
        sessionId,
        nativeSidecarStatus: 'mock',
    };
}

function taskCompletedEvent(sessionId: string): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: '2026-06-04T10:00:01.000Z',
        sessionId,
        taskId: 'task_jsonl',
        message: 'completed from jsonl',
        nativeSidecarStatus: 'mock',
    };
}
