import { afterEach, describe, expect, it } from 'vitest';
import { type ImportAccumulator, importJsonlSource } from './session-import-sources.js';
import { ensureLegacySessionImportTables } from './session-import-sql.js';
import { countRows, openMigratedTestDb, writeLegacyFixture } from './session-import-test-support.js';
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
        const givenFailure = new Error('injected JSONL import write failure');
        const givenClient = new Proxy(runtime.client, {
            get(target, property, receiver) {
                if (property === 'batch') {
                    return async () => {
                        throw givenFailure;
                    };
                }
                return boundClientMember(target, property, receiver);
            },
        });

        try {
            await ensureLegacySessionImportTables(runtime.client);

            await expect(
                importJsonlSource({
                    writeTarget: { url: runtime.url, client: givenClient },
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

function boundClientMember(target: object, property: string | symbol, receiver: unknown): unknown {
    const value = Reflect.get(target, property, receiver);
    if (typeof value === 'function') {
        return value.bind(target);
    }
    return value;
}
