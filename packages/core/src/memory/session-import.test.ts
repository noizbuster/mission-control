import { RunSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJsonlSessionLog } from './jsonl-session-records.js';
import {
    exportLegacySessionJsonl,
    importLegacySessionCompatibilityWindow,
    listLegacySessionImportLedger,
} from './session-import.js';
import { importMissionRunRow } from './session-import-run-sql.js';
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

    it('imports JSONL and run records while leaving legacy source bytes unchanged', async () => {
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
            expect(whenSecondImport.skippedSourceCount).toBe(2);
            await expect(countRows(client, 'session_events')).resolves.toBe(2);
            await expect(countRows(client, 'legacy_session_imports')).resolves.toBe(2);
        } finally {
            runtime.close();
        }
    });

    it('does not let direct legacy SQL imports mint owner authority or overwrite existing status', async () => {
        const givenFixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'canonical-run-owner' });
        const runtime = await openMigratedTestDb();
        const canonical = RunSchema.parse({
            id: 'run_legacy',
            missionId: 'mission-canonical',
            status: 'blocked',
            sessionId: SESSION_IMPORT_TEST_SESSION_ID,
            sessionRunId: 'owner_canonical',
        });

        try {
            await importMissionRunRow({
                client: runtime.client,
                run: canonical,
                importedAt: '2026-06-30T00:00:00.000Z',
            });

            const whenResult = await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: givenFixture.dataDir,
                omoRoot: givenFixture.omoRoot,
                now: () => '2026-07-01T00:00:00.000Z',
            });
            const row = await readMissionRunDbRow(runtime.client, canonical.id);
            const persisted = RunSchema.parse(JSON.parse(String(row['passthrough_json'])));

            expect(whenResult.importedRunCount).toBe(0);
            expect(persisted).toMatchObject({
                status: 'blocked',
            });
            expect(persisted.sessionRunId).toBeUndefined();
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
            expect(whenResult.importedRunCount).toBe(0);
            expect(whenResult.diagnostics).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ sourceKind: 'jsonl', code: 'corrupt_jsonl' }),
                    expect.objectContaining({ sourceKind: 'mission_run', code: 'invalid_run' }),
                ]),
            );
            await expect(readSourceBytes(givenFixture)).resolves.toEqual(before);
            await expect(countRows(client, 'legacy_session_imports')).resolves.toBe(2);
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

    it('redacts token-like credentials while importing legacy envelopes', async () => {
        // Given
        const secret = ['sk', 'legacy', 'importsecret123'].join('-');
        const givenFixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'redacted-import' });
        const source = (await readFile(givenFixture.jsonlPath, 'utf8')).replace(
            'legacy text is imported as data only: $(echo no-exec)',
            `legacy event ${secret}`,
        );
        await writeFile(givenFixture.jsonlPath, source, 'utf8');
        const runtime = await openMigratedTestDb();

        try {
            // When
            await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: givenFixture.dataDir,
                omoRoot: givenFixture.omoRoot,
                now: () => '2026-07-01T00:00:00.000Z',
            });
            const rows = await runtime.client.execute('SELECT payload_json FROM session_events ORDER BY seq');
            const observable = JSON.stringify(rows.rows);

            // Then
            expect(observable).toContain('[REDACTED_CREDENTIAL]');
            expect(observable).not.toContain(secret);
        } finally {
            runtime.close();
        }
    });
});
