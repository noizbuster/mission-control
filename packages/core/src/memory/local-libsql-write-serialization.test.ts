import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalLibsqlWriteTarget, openLocalLibsqlDb, runWithLocalLibsqlWriteLock } from '../db/local-libsql-db';
import { envelope, sessionStoppedEvent } from '../session-replay-coding-test-support';
import { openSqliteSessionEventStoreForTests } from './sqlite-session-event-store-test-support';
import { projectSessionEventsToSqlite } from './sqlite-session-projection';
import { openSqliteSessionProjectionStoreForTests } from './sqlite-session-projection-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CREATED_AT = '2026-06-05T09:59:59.000Z';
const tempDirs: string[] = [];

describe('local libSQL write serialization', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('serializes projection replacement behind the same write lane used by appends', async () => {
        // Given: an append path and projection store target the same local libSQL URL.
        const url = await tempDbUrl('projection');
        const appendStore = await openSqliteSessionEventStoreForTests({
            url,
            sessionId: 'projection_serialized',
            createEventId: () => 'event_append_started',
        });
        await appendStore.append(sessionStartedEvent('projection_serialized'));
        await appendStore.close();
        const store = await openSqliteSessionProjectionStoreForTests(url);
        const runtime = await openLocalLibsqlDb({ url });
        const releaseLane = deferred();
        const holdingWrite = holdWriteLaneWithSessionStatus({
            target: runtime,
            release: releaseLane.promise,
            sessionId: 'projection_serialized',
        });
        await holdingWrite.started;

        // When: replacement starts while another local write is holding the shared lane.
        const projecting = projectSessionEventsToSqlite({
            store,
            sessionId: 'projection_serialized',
            sourcePath: 'sessions/projection_serialized.jsonl',
            envelopes: [
                envelope(sessionStartedEvent('projection_serialized'), 0, 'event_projection_started'),
                envelope(sessionStoppedEvent('projection_serialized'), 1, 'event_projection_stopped'),
            ],
        });
        await Promise.resolve();
        releaseLane.resolve();
        await projecting;
        await holdingWrite.done;

        // Then: replacement ran after the held write and restored the derived stopped status.
        const rows = await runtime.client.execute({
            sql: 'SELECT status, last_event_seq FROM sessions WHERE session_id = ?',
            args: ['projection_serialized'],
        });
        expect(rows.rows).toEqual([{ status: 'stopped', last_event_seq: 1 }]);
        runtime.close();
        store.close();
    });
});

type Deferred = {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
};

type HeldWrite = {
    readonly started: Promise<void>;
    readonly done: Promise<void>;
};

function deferred(): Deferred {
    let resolvePromise: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    if (resolvePromise === undefined) {
        throw new Error('failed to create deferred resolver');
    }
    return { promise, resolve: resolvePromise };
}

async function tempDir(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `mctrl-write-serialization-${name}-`));
    tempDirs.push(dir);
    return dir;
}

async function tempDbUrl(name: string): Promise<string> {
    return `file:${join(await tempDir(name), 'mission-control.db')}`;
}

function holdWriteLaneWithSessionStatus(input: {
    readonly target: LocalLibsqlWriteTarget;
    readonly release: Promise<void>;
    readonly sessionId: string;
}): HeldWrite {
    return holdWriteLane(input.target, async () => {
        await input.release;
        await input.target.client.execute({
            sql: `
                INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at, last_event_seq)
                VALUES (?, 'idle', ?, ?, ?, 999)
                ON CONFLICT(session_id) DO UPDATE SET
                    status = 'idle',
                    updated_at = excluded.updated_at,
                    last_activity_at = excluded.last_activity_at,
                    last_event_seq = excluded.last_event_seq
            `,
            args: [input.sessionId, CREATED_AT, CREATED_AT, CREATED_AT],
        });
    });
}

function holdWriteLane(target: LocalLibsqlWriteTarget, write: () => Promise<void>): HeldWrite {
    const started = deferred();
    const done = runWithLocalLibsqlWriteLock(target, async () => {
        started.resolve();
        await write();
    });
    return { started: started.promise, done };
}

function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: CREATED_AT,
        sessionId,
        message: 'mission-control session started',
    };
}
