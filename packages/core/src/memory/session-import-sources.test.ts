import { afterEach, describe, expect, it } from 'vitest';
import { type ImportAccumulator, importJsonlSource } from './session-import-sources';
import { countRows, openMigratedTestDb, writeLegacyFixture } from './session-import-test-support';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP_ROOT = join(process.cwd(), 'tmp', 'session-import-sources-tests');

describe('legacy session import source error boundaries', () => {
    afterEach(async () => {
        await rm(TMP_ROOT, { recursive: true, force: true });
    });

    it('rejects JSONL import when event storage fails instead of recording corrupt legacy input', async () => {
        const givenFixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'jsonl-import-write-failure' });
        const runtime = await openMigratedTestDb();
        const givenAcc = emptyImportAccumulator();

        try {
            await runtime.client.execute(`
                CREATE TRIGGER fail_jsonl_event_insert
                BEFORE INSERT ON session_events
                BEGIN SELECT RAISE(ABORT, 'injected JSONL import write failure'); END
            `);

            await expect(
                importJsonlSource({
                    writeTarget: runtime,
                    sourcePath: givenFixture.jsonlPath,
                    now: () => '2026-07-01T00:00:00.000Z',
                    acc: givenAcc,
                }),
            ).rejects.toThrow('injected JSONL import write failure');

            expect(givenAcc.diagnostics).toEqual([]);
            await expect(countRows(runtime.client, 'legacy_session_imports')).resolves.toBe(0);
        } finally {
            runtime.close();
        }
    });
});

function emptyImportAccumulator(): ImportAccumulator {
    return {
        importedEventCount: 0,
        importedRunCount: 0,
        skippedSourceCount: 0,
        diagnostics: [],
    };
}
