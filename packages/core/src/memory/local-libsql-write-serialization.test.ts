import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalLibsqlWriteTarget, openLocalLibsqlDb, runWithLocalLibsqlWriteLock } from '../db/local-libsql-db.js';
import { envelope, sessionStoppedEvent } from '../session-replay-coding-test-support.js';
import { exportLegacySessionJsonl, importLegacySessionCompatibilityWindow } from './session-import.js';
import { SESSION_IMPORT_TEST_SESSION_ID, writeLegacyFixture } from './session-import-test-support.js';
import { openSqliteSessionEventStoreForTests } from './sqlite-session-event-store-test-support.js';
import { projectSessionEventsToSqlite } from './sqlite-session-projection.js';
import { openSqliteSessionProjectionStoreForTests } from './sqlite-session-projection-test-support.js';
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

    it('serializes legacy JSONL import behind the shared local write lane', async () => {
        // Given: a legacy JSONL source is imported into the same URL used by append writes.
        const root = await tempDir('import');
        const fixture = await writeLegacyFixture({ tmpRoot: root, name: 'legacy-import' });
        const runtime = await openMigratedDb(await tempDbUrl('legacy-import'));
        const releaseLane = deferred();
        const holdingWrite = holdWriteLaneWithSessionStatus({
            target: runtime,
            release: releaseLane.promise,
            sessionId: SESSION_IMPORT_TEST_SESSION_ID,
        });
        await holdingWrite.started;

        // When: compatibility import starts while the lane is held.
        const importing = importLegacySessionCompatibilityWindow({
            ...runtime,
            dataDir: fixture.dataDir,
            omoRoot: fixture.omoRoot,
            now: () => '2026-07-01T00:00:00.000Z',
        });
        await Promise.resolve();
        releaseLane.resolve();
        await importing;
        await holdingWrite.done;

        // Then: imported session state won the queue order instead of racing before the held write.
        const rows = await runtime.client.execute({
            sql: 'SELECT status, last_event_seq FROM sessions WHERE session_id = ?',
            args: [SESSION_IMPORT_TEST_SESSION_ID],
        });
        expect(rows.rows).toEqual([{ status: 'stopped', last_event_seq: 1 }]);
        runtime.close();
    });

    it('serializes legacy export marking behind the shared local write lane', async () => {
        // Given: an imported legacy session can be exported from the local libSQL store.
        const root = await tempDir('export');
        const fixture = await writeLegacyFixture({ tmpRoot: root, name: 'legacy-export' });
        const runtime = await openMigratedDb(await tempDbUrl('legacy-export'));
        await importLegacySessionCompatibilityWindow({
            ...runtime,
            dataDir: fixture.dataDir,
            omoRoot: fixture.omoRoot,
            now: () => '2026-07-01T00:00:00.000Z',
        });
        const releaseLane = deferred();
        const holdingWrite = holdWriteLaneWithExportMarker({
            target: runtime,
            release: releaseLane.promise,
            sessionId: SESSION_IMPORT_TEST_SESSION_ID,
        });
        await holdingWrite.started;

        // When: export writes its marker while the shared write lane is held.
        const exporting = exportLegacySessionJsonl({
            ...runtime,
            sessionId: SESSION_IMPORT_TEST_SESSION_ID,
            outputDir: join(root, 'exports'),
            now: () => '2026-07-01T00:02:00.000Z',
        });
        await Promise.resolve();
        releaseLane.resolve();
        await exporting;
        await holdingWrite.done;

        // Then: the export marker ran after the held write.
        const rows = await runtime.client.execute({
            sql: 'SELECT exported_at FROM sessions WHERE session_id = ?',
            args: [SESSION_IMPORT_TEST_SESSION_ID],
        });
        expect(rows.rows).toEqual([{ exported_at: '2026-07-01T00:02:00.000Z' }]);
        runtime.close();
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

async function openMigratedDb(url: string) {
    return openLocalLibsqlDb({ url });
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

function holdWriteLaneWithExportMarker(input: {
    readonly target: LocalLibsqlWriteTarget;
    readonly release: Promise<void>;
    readonly sessionId: string;
}): HeldWrite {
    return holdWriteLane(input.target, async () => {
        await input.release;
        await input.target.client.execute({
            sql: 'UPDATE sessions SET exported_at = ? WHERE session_id = ?',
            args: ['held-write-marker', input.sessionId],
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
