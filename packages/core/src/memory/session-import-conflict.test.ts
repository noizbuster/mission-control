import { afterEach, describe, expect, it } from 'vitest';
import { importLegacySessionCompatibilityWindow } from './session-import.js';
import { legacyEnvelope, readLegacyEnvelopes, writeLegacyLog } from './session-import-regression-test-support.js';
import {
    countRows,
    openMigratedTestDb,
    SESSION_IMPORT_TEST_CREATED_AT,
    SESSION_IMPORT_TEST_SESSION_ID,
    writeLegacyFixture,
} from './session-import-test-support.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP_ROOT = join(process.cwd(), 'tmp', 'session-import-conflict-tests');

describe('legacy JSONL import identity conflicts', () => {
    afterEach(async () => {
        await rm(TMP_ROOT, { recursive: true, force: true });
    });

    it('rejects a changed envelope at an existing session sequence without partial mutation', async () => {
        const fixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'sequence-collision' });
        const runtime = await openMigratedTestDb();
        try {
            await importFixture(runtime, fixture.dataDir);
            const envelopes = await readLegacyEnvelopes({
                filePath: fixture.jsonlPath,
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
            });
            const first = envelopes[0];
            if (first === undefined) throw new Error('missing sequence collision fixture event');
            await writeLegacyLog({
                filePath: fixture.jsonlPath,
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
                createdAt: SESSION_IMPORT_TEST_CREATED_AT,
                envelopes: [
                    first,
                    legacyEnvelope({
                        sessionId: SESSION_IMPORT_TEST_SESSION_ID,
                        eventId: 'event_changed_at_sequence_one',
                        sequence: 1,
                        timestamp: '2026-06-30T01:00:04.000Z',
                        message: 'changed collision content',
                    }),
                ],
            });

            await expect(importFixture(runtime, fixture.dataDir)).rejects.toMatchObject({
                name: 'LegacySessionImportConflictError',
                code: 'sequence_collision',
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
            });

            await expect(countRows(runtime.client, 'session_events')).resolves.toBe(2);
            await expect(countRows(runtime.client, 'legacy_session_imports')).resolves.toBe(1);
        } finally {
            runtime.close();
        }
    });

    it('rejects an event id reused by another session without creating that session', async () => {
        const fixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'event-id-collision' });
        const runtime = await openMigratedTestDb();
        const otherSessionId = 'legacy_other_session';
        try {
            await importFixture(runtime, fixture.dataDir);
            const otherPath = join(fixture.dataDir, 'sessions', `${otherSessionId}.jsonl`);
            await mkdir(join(fixture.dataDir, 'sessions'), { recursive: true });
            await writeLegacyLog({
                filePath: otherPath,
                sessionId: otherSessionId,
                createdAt: SESSION_IMPORT_TEST_CREATED_AT,
                envelopes: [
                    legacyEnvelope({
                        sessionId: otherSessionId,
                        eventId: 'event_started',
                        sequence: 0,
                        timestamp: '2026-06-30T01:00:05.000Z',
                        message: 'different session reused an event id',
                    }),
                ],
            });

            await expect(importFixture(runtime, fixture.dataDir)).rejects.toMatchObject({
                name: 'LegacySessionImportConflictError',
                code: 'event_id_collision',
                eventId: 'event_started',
            });

            const sessions = await runtime.client.execute('SELECT session_id FROM sessions ORDER BY session_id');
            expect(sessions.rows).toEqual([{ session_id: SESSION_IMPORT_TEST_SESSION_ID }]);
            await expect(countRows(runtime.client, 'session_events')).resolves.toBe(2);
            await expect(countRows(runtime.client, 'legacy_session_imports')).resolves.toBe(1);
        } finally {
            runtime.close();
        }
    });
});

type TestRuntime = Awaited<ReturnType<typeof openMigratedTestDb>>;

function importFixture(runtime: TestRuntime, dataDir: string) {
    return importLegacySessionCompatibilityWindow({
        ...runtime,
        dataDir,
        includeRunSources: false,
        now: () => '2026-07-01T00:00:00.000Z',
    });
}
