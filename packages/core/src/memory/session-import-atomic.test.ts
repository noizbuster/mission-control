import { afterEach, describe, expect, it, vi } from 'vitest';
import { importLegacySessionCompatibilityWindow, listLegacySessionImportLedger } from './session-import.js';
import {
    emptyImportAccumulator,
    legacyEnvelope,
    readLegacyEnvelopes,
    sessionSummary,
    writeLegacyLog,
} from './session-import-regression-test-support.js';
import { importJsonlSource } from './session-import-sources.js';
import {
    countRows,
    openMigratedTestDb,
    SESSION_IMPORT_TEST_CREATED_AT,
    SESSION_IMPORT_TEST_SESSION_ID,
    writeLegacyFixture,
} from './session-import-test-support.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP_ROOT = join(process.cwd(), 'tmp', 'session-import-atomic-tests');

describe('legacy JSONL import atomicity', () => {
    afterEach(async () => {
        await rm(TMP_ROOT, { recursive: true, force: true });
    });

    it('counts only newly appended exact events when a source checksum changes', async () => {
        const fixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'appended' });
        const runtime = await openMigratedTestDb();
        try {
            await importFixture(runtime, fixture.dataDir);
            const envelopes = await readLegacyEnvelopes({
                filePath: fixture.jsonlPath,
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
            });
            await writeLegacyLog({
                filePath: fixture.jsonlPath,
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
                createdAt: SESSION_IMPORT_TEST_CREATED_AT,
                envelopes: [
                    ...envelopes,
                    legacyEnvelope({
                        sessionId: SESSION_IMPORT_TEST_SESSION_ID,
                        eventId: 'event_appended',
                        sequence: 2,
                        timestamp: '2026-06-30T01:00:03.000Z',
                        message: 'appended legacy event',
                    }),
                ],
            });

            const result = await importFixture(runtime, fixture.dataDir);
            const ledger = await listLegacySessionImportLedger(runtime.client);

            expect(result.importedEventCount).toBe(1);
            await expect(countRows(runtime.client, 'session_events')).resolves.toBe(3);
            expect(
                ledger
                    .filter(({ sourceKind }) => sourceKind === 'jsonl')
                    .map((entry) => entry.importedEventCount)
                    .sort((left, right) => left - right),
            ).toEqual([1, 2]);
        } finally {
            runtime.close();
        }
    });

    it('records a changed source checksum with zero inserts when all envelopes are exact', async () => {
        const fixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'changed-header' });
        const runtime = await openMigratedTestDb();
        try {
            await importFixture(runtime, fixture.dataDir);
            const envelopes = await readLegacyEnvelopes({
                filePath: fixture.jsonlPath,
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
            });
            await writeLegacyLog({
                filePath: fixture.jsonlPath,
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
                createdAt: '2026-06-30T00:59:59.000Z',
                envelopes,
            });

            const result = await importFixture(runtime, fixture.dataDir);
            const ledger = await listLegacySessionImportLedger(runtime.client);

            expect(result.importedEventCount).toBe(0);
            expect(
                ledger
                    .filter(({ sourceKind }) => sourceKind === 'jsonl')
                    .map((entry) => entry.importedEventCount)
                    .sort((left, right) => left - right),
            ).toEqual([0, 2]);
        } finally {
            runtime.close();
        }
    });

    it('rolls back inserted events when the checksum ledger write fails', async () => {
        const fixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'ledger-failure' });
        const runtime = await openMigratedTestDb();
        try {
            await runtime.client.execute(`
                CREATE TRIGGER fail_legacy_import_ledger
                BEFORE INSERT ON legacy_session_imports
                BEGIN SELECT RAISE(ABORT, 'injected import ledger failure'); END
            `);

            await expect(importFixture(runtime, fixture.dataDir)).rejects.toThrow('injected import ledger failure');

            await expect(countRows(runtime.client, 'session_events')).resolves.toBe(0);
            await expect(countRows(runtime.client, 'sessions')).resolves.toBe(0);
            await expect(countRows(runtime.client, 'legacy_session_imports')).resolves.toBe(0);
        } finally {
            runtime.close();
        }
    });

    it('serializes checksum detection with event insertion for concurrent source imports', async () => {
        const fixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'serialized' });
        const runtime = await openMigratedTestDb();
        const firstAcc = emptyImportAccumulator();
        const secondAcc = emptyImportAccumulator();
        const originalExecute = runtime.client.execute.bind(runtime.client);
        const bothChecksumReads = deferred();
        let checksumReadCount = 0;
        let transactionStarted = false;
        vi.spyOn(runtime.client, 'execute').mockImplementation(async (statement) => {
            const sql = statementSql(statement);
            if (sql === 'BEGIN IMMEDIATE TRANSACTION') {
                transactionStarted = true;
                bothChecksumReads.resolve();
            }
            if (sql.includes('FROM legacy_session_imports WHERE source_path')) {
                checksumReadCount += 1;
                if (checksumReadCount === 2) bothChecksumReads.resolve();
                if (!transactionStarted) await bothChecksumReads.promise;
            }
            return originalExecute(statement);
        });
        try {
            const first = importJsonlSource({
                writeTarget: runtime,
                sourcePath: fixture.jsonlPath,
                now: () => '2026-07-01T00:00:00.000Z',
                acc: firstAcc,
            });
            const second = importJsonlSource({
                writeTarget: runtime,
                sourcePath: fixture.jsonlPath,
                now: () => '2026-07-01T00:00:01.000Z',
                acc: secondAcc,
            });
            await Promise.all([first, second]);

            expect([firstAcc.importedEventCount, secondAcc.importedEventCount].sort()).toEqual([0, 2]);
            expect(firstAcc.skippedSourceCount + secondAcc.skippedSourceCount).toBe(1);
            await expect(countRows(runtime.client, 'legacy_session_imports')).resolves.toBe(1);
        } finally {
            runtime.close();
        }
    });

    it('uses maximum canonical event time for monotonic session activity', async () => {
        const dataDir = join(TMP_ROOT, 'monotonic-time', 'data');
        const sessionsDir = join(dataDir, 'sessions');
        const sessionId = 'legacy_monotonic_time';
        const filePath = join(sessionsDir, `${sessionId}.jsonl`);
        await mkdir(sessionsDir, { recursive: true });
        await writeLegacyLog({
            filePath,
            sessionId,
            createdAt: '2026-06-30T00:00:00.000Z',
            envelopes: [
                legacyEnvelope({
                    sessionId,
                    eventId: 'late',
                    sequence: 0,
                    timestamp: '2026-06-30T00:00:10.000Z',
                    message: 'late',
                }),
                legacyEnvelope({
                    sessionId,
                    eventId: 'early',
                    sequence: 1,
                    timestamp: '2026-06-30T00:00:05.000Z',
                    message: 'early',
                }),
            ],
        });
        const runtime = await openMigratedTestDb();
        try {
            await importFixture(runtime, dataDir);

            await expect(sessionSummary(runtime.client, sessionId)).resolves.toMatchObject({
                updated_at: '2026-06-30T00:00:10.000Z',
                last_activity_at: '2026-06-30T00:00:10.000Z',
                last_event_seq: 1,
            });
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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolvePromise: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    if (resolvePromise === undefined) throw new Error('failed to create deferred resolver');
    return { promise, resolve: resolvePromise };
}

function statementSql(statement: unknown): string {
    if (typeof statement === 'string') return statement;
    if (typeof statement === 'object' && statement !== null && 'sql' in statement) {
        const sql = statement.sql;
        return typeof sql === 'string' ? sql : '';
    }
    return '';
}
