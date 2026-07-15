import { RunSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMissionRunStoreLocation } from './mission-run-store-location';
import { findMostRecentFailedRun } from './run-store';
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

function makeTempLocation(): NormalizedMissionRunStoreLocation {
    const root = mkdtempSync(join(tmpdir(), 'failed-run-store-test-'));
    tempRoots.push(root);
    return { omoRoot: join(root, 'project'), dataDir: join(root, 'data') };
}

function writeLegacyRun(root: string, runId: string, contents: string): void {
    const runsDir = join(root, '.omo', 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, `${runId}.json`), contents);
}

describe('findMostRecentFailedRun', () => {
    it('fails closed when legacy failed run JSON is corrupt', async () => {
        // Given
        const location = makeTempLocation();
        writeLegacyRun(location.omoRoot, 'invalid-json', '{ broken');

        // When
        await expect(findMostRecentFailedRun(location)).rejects.toMatchObject({ code: 'legacy_run_corrupt' });
    });

    it('fails closed when legacy failed run schema is invalid', async () => {
        // Given
        const location = makeTempLocation();
        writeLegacyRun(location.omoRoot, 'invalid-schema', JSON.stringify({ id: 'invalid-schema', status: 'failed' }));

        // When
        await expect(findMostRecentFailedRun(location)).rejects.toMatchObject({ code: 'legacy_run_corrupt' });
    });

    it('rethrows unexpected parser errors when scanning legacy failed runs', async () => {
        // Given
        const location = makeTempLocation();
        writeLegacyRun(
            location.omoRoot,
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
        await expect(findMostRecentFailedRun(location)).rejects.toBe(parserError);
    });
});
