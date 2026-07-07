import { afterEach, describe, expect, it } from 'vitest';
import { parseJsonlSessionLog } from './jsonl-session-records.js';
import {
    exportLegacySessionJsonl,
    importLegacySessionCompatibilityWindow,
    listLegacySessionImportLedger,
} from './session-import.js';
import {
    countRows,
    openMigratedTestDb,
    readMissionRunDbRow,
    readSourceBytes,
    SESSION_IMPORT_TEST_SESSION_ID,
    writeLegacyFixture,
} from './session-import-test-support.js';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TMP_ROOT = join(process.cwd(), 'tmp', 'session-import-tests');

describe('legacy session import compatibility window', () => {
    afterEach(async () => {
        await rm(TMP_ROOT, { recursive: true, force: true });
    });

    it('imports JSONL, session-index, and run records while leaving legacy source bytes unchanged', async () => {
        const givenFixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'complete-import' });
        const runtime = await openMigratedTestDb();
        const client = runtime.client;
        const before = await readSourceBytes(givenFixture);

        try {
            const whenResult = await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: givenFixture.dataDir,
                omoRoot: givenFixture.omoRoot,
                now: () => '2026-07-01T00:00:00.000Z',
            });
            const after = await readSourceBytes(givenFixture);

            expect(whenResult).toMatchObject({
                importedEventCount: 2,
                importedSessionIndexRecordCount: 1,
                importedRunCount: 1,
                skippedSourceCount: 0,
                diagnostics: [],
            });
            expect(after).toEqual(before);
            await expect(countRows(client, 'session_events')).resolves.toBe(2);
            await expect(countRows(client, 'sessions')).resolves.toBe(1);
            await expect(countRows(client, 'mission_runs')).resolves.toBe(1);
            await expect(readMissionRunDbRow(client, 'run_legacy')).resolves.toMatchObject({
                run_id: 'run_legacy',
                prompt: 'legacy prompt',
                updated_at: '2026-07-01T00:00:00.000Z',
                ended_at: '2026-06-30T01:00:02.000Z',
                passthrough_json: expect.stringContaining('"id":"run_legacy"'),
            });
            await expect(listLegacySessionImportLedger(client)).resolves.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ sourceKind: 'jsonl', importedEventCount: 2 }),
                    expect.objectContaining({ sourceKind: 'session_index', importedEventCount: 0 }),
                    expect.objectContaining({ sourceKind: 'mission_run', importedEventCount: 0 }),
                ]),
            );
        } finally {
            runtime.close();
        }
    });

    it('skips already imported files when re-imported into the same SQLite store', async () => {
        const givenFixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'idempotent-import' });
        const runtime = await openMigratedTestDb();
        const client = runtime.client;

        try {
            await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: givenFixture.dataDir,
                omoRoot: givenFixture.omoRoot,
                now: () => '2026-07-01T00:00:00.000Z',
            });

            const whenSecondImport = await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: givenFixture.dataDir,
                omoRoot: givenFixture.omoRoot,
                now: () => '2026-07-01T00:01:00.000Z',
            });

            expect(whenSecondImport.importedEventCount).toBe(0);
            expect(whenSecondImport.importedRunCount).toBe(0);
            expect(whenSecondImport.importedSessionIndexRecordCount).toBe(0);
            expect(whenSecondImport.skippedSourceCount).toBe(3);
            await expect(countRows(client, 'session_events')).resolves.toBe(2);
            await expect(countRows(client, 'legacy_session_imports')).resolves.toBe(3);
        } finally {
            runtime.close();
        }
    });

    it('records diagnostics for corrupt JSONL and malformed run JSON without throwing away other imports', async () => {
        const givenFixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'malformed-input' });
        await writeFile(givenFixture.jsonlPath, '{not json}\n', 'utf8');
        await writeFile(givenFixture.runPath, '{"id": ""}\n', 'utf8');
        const before = await readSourceBytes(givenFixture);
        const runtime = await openMigratedTestDb();
        const client = runtime.client;

        try {
            const whenResult = await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: givenFixture.dataDir,
                omoRoot: givenFixture.omoRoot,
                now: () => '2026-07-01T00:00:00.000Z',
            });

            expect(whenResult.importedEventCount).toBe(0);
            expect(whenResult.importedSessionIndexRecordCount).toBe(1);
            expect(whenResult.importedRunCount).toBe(0);
            expect(whenResult.diagnostics).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ sourceKind: 'jsonl', code: 'corrupt_jsonl' }),
                    expect.objectContaining({ sourceKind: 'mission_run', code: 'invalid_run' }),
                ]),
            );
            await expect(readSourceBytes(givenFixture)).resolves.toEqual(before);
            await expect(countRows(client, 'legacy_session_imports')).resolves.toBe(3);
        } finally {
            runtime.close();
        }
    });

    it('records diagnostics for malformed session-index JSON while preserving source bytes', async () => {
        const givenFixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'malformed-session-index' });
        await writeFile(
            givenFixture.indexPath,
            '{"version": 1, "records": "not-an-array", "diagnostics": []}\n',
            'utf8',
        );
        const before = await readSourceBytes(givenFixture);
        const runtime = await openMigratedTestDb();
        const client = runtime.client;

        try {
            const whenResult = await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: givenFixture.dataDir,
                omoRoot: givenFixture.omoRoot,
                now: () => '2026-07-01T00:00:00.000Z',
            });

            expect(whenResult.importedEventCount).toBe(2);
            expect(whenResult.importedSessionIndexRecordCount).toBe(0);
            expect(whenResult.importedRunCount).toBe(1);
            expect(whenResult.diagnostics).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ sourceKind: 'session_index', code: 'invalid_session_index' }),
                ]),
            );
            await expect(readSourceBytes(givenFixture)).resolves.toEqual(before);
            await expect(countRows(client, 'legacy_session_imports')).resolves.toBe(3);
        } finally {
            runtime.close();
        }
    });

    it('exports imported SQLite events back to a parseable JSONL replay file', async () => {
        const givenFixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'export-replay' });
        const runtime = await openMigratedTestDb();
        await importLegacySessionCompatibilityWindow({
            ...runtime,
            dataDir: givenFixture.dataDir,
            omoRoot: givenFixture.omoRoot,
            now: () => '2026-07-01T00:00:00.000Z',
        });

        try {
            const whenOutput = await exportLegacySessionJsonl({
                ...runtime,
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
                outputDir: join(givenFixture.root, 'exports'),
                now: () => '2026-07-01T00:02:00.000Z',
            });
            const contents = await readFile(whenOutput.filePath, 'utf8');
            const parsed = parseJsonlSessionLog({
                contents,
                filePath: whenOutput.filePath,
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
            });

            expect(whenOutput.exportedEventCount).toBe(2);
            expect(parsed.envelopes.map((envelope) => envelope.eventId)).toEqual(['event_started', 'event_stopped']);
            expect(parsed.envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
        } finally {
            runtime.close();
        }
    });
});
