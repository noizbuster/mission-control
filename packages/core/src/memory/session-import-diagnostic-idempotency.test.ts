import { afterEach, describe, expect, it, vi } from 'vitest';
import { importLegacySessionCompatibilityWindow } from './session-import';
import { countRows, openMigratedTestDb, writeLegacyFixture } from './session-import-test-support';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TMP_ROOT = join(process.cwd(), 'tmp', 'session-import-diagnostic-idempotency-tests');

describe('legacy JSONL diagnostic import idempotency', () => {
    afterEach(async () => {
        await rm(TMP_ROOT, { recursive: true, force: true });
    });

    it('skips an exact corrupt source after its checksum diagnostic is recorded', async () => {
        const fixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'corrupt-duplicate' });
        await writeFile(fixture.jsonlPath, '{not json}\n', 'utf8');
        const runtime = await openMigratedTestDb();
        try {
            const first = await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: fixture.dataDir,
                includeRunSources: false,
            });

            const second = await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir: fixture.dataDir,
                includeRunSources: false,
            });

            expect(first.diagnostics).toEqual([
                expect.objectContaining({ sourceKind: 'jsonl', code: 'corrupt_jsonl' }),
            ]);
            expect(second).toMatchObject({
                importedEventCount: 0,
                skippedSourceCount: 1,
                diagnostics: [],
            });
            await expect(countRows(runtime.client, 'legacy_session_imports')).resolves.toBe(1);
        } finally {
            runtime.close();
        }
    });

    it('serializes concurrent corrupt-source diagnostics with checksum recording', async () => {
        const fixture = await writeLegacyFixture({ tmpRoot: TMP_ROOT, name: 'corrupt-concurrent' });
        await writeFile(fixture.jsonlPath, '{not json}\n', 'utf8');
        const runtime = await openMigratedTestDb();
        const originalExecute = runtime.client.execute.bind(runtime.client);
        const bothChecksumReads = deferred();
        let checksumReadCount = 0;
        vi.spyOn(runtime.client, 'execute').mockImplementation(async (statement) => {
            if (statementSql(statement).includes('FROM legacy_session_imports WHERE source_path')) {
                checksumReadCount += 1;
                if (checksumReadCount === 2) bothChecksumReads.resolve();
                await bothChecksumReads.promise;
            }
            return originalExecute(statement);
        });
        try {
            const results = await Promise.all([
                importLegacySessionCompatibilityWindow({
                    ...runtime,
                    dataDir: fixture.dataDir,
                    includeRunSources: false,
                }),
                importLegacySessionCompatibilityWindow({
                    ...runtime,
                    dataDir: fixture.dataDir,
                    includeRunSources: false,
                }),
            ]);

            expect(results.reduce((total, result) => total + result.diagnostics.length, 0)).toBe(1);
            expect(results.reduce((total, result) => total + result.skippedSourceCount, 0)).toBe(1);
            await expect(countRows(runtime.client, 'legacy_session_imports')).resolves.toBe(1);
        } finally {
            runtime.close();
        }
    });
});

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
