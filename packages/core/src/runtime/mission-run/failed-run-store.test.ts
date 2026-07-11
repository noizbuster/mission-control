import { RunSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { missionControlDataDirEnvKey } from '../../memory/data-dir.js';
import { findMostRecentFailedRun } from './run-store.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'failed-run-store-test-'));
    tempRoots.push(root);
    vi.stubEnv(missionControlDataDirEnvKey, root);
    return root;
}

function writeLegacyRun(root: string, runId: string, contents: string): void {
    const runsDir = join(root, '.omo', 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, `${runId}.json`), contents);
}

describe('findMostRecentFailedRun', () => {
    it('fails closed when legacy failed run JSON is corrupt', async () => {
        // Given
        const root = makeTempRoot();
        writeLegacyRun(root, 'invalid-json', '{ broken');

        // When
        await expect(findMostRecentFailedRun(root)).rejects.toMatchObject({ code: 'legacy_run_corrupt' });
    });

    it('fails closed when legacy failed run schema is invalid', async () => {
        // Given
        const root = makeTempRoot();
        writeLegacyRun(root, 'invalid-schema', JSON.stringify({ id: 'invalid-schema', status: 'failed' }));

        // When
        await expect(findMostRecentFailedRun(root)).rejects.toMatchObject({ code: 'legacy_run_corrupt' });
    });

    it('rethrows unexpected parser errors when scanning legacy failed runs', async () => {
        // Given
        const root = makeTempRoot();
        writeLegacyRun(
            root,
            'unexpected-parser-error',
            JSON.stringify({
                id: 'unexpected-parser-error',
                missionId: 'mission-1',
                status: 'failed',
                endedAt: '2026-01-01T00:00:00.000Z',
            }),
        );
        const parserError = new TypeError('schema parser bug');
        vi.spyOn(RunSchema, 'parse').mockImplementation(() => {
            throw parserError;
        });

        // When / Then
        await expect(findMostRecentFailedRun(root)).rejects.toBe(parserError);
    });
});
