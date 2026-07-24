import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundJobHandle, DurableBackgroundJobHandle } from './async-job-manager';
import { loadPersistedJobs, persistJob } from './job-persistence';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'omo-jobs-'));
    tempDirs.push(dir);
    return dir;
}

function sampleHandle(overrides: Partial<DurableBackgroundJobHandle> = {}): DurableBackgroundJobHandle {
    return {
        jobId: 'job_test_1',
        sessionId: 'ses_1',
        status: 'running',
        startedAt: '2026-06-22T00:00:00.000Z',
        ...overrides,
    };
}

describe('persistJob', () => {
    it('writes a JSON file at <jobsDir>/<jobId>.json', async () => {
        // Given
        const jobsDir = makeTempDir();
        const handle = sampleHandle({ jobId: 'job_abc' });

        // When
        await persistJob(jobsDir, handle);

        // Then
        const entries = readdirSync(jobsDir);
        expect(entries).toEqual(['job_abc.json']);
    });

    it('creates the jobs directory when it does not exist', async () => {
        // Given
        const parent = makeTempDir();
        const jobsDir = join(parent, 'nested', 'jobs');
        const handle = sampleHandle({ jobId: 'job_new' });

        // When
        await persistJob(jobsDir, handle);

        // Then
        expect(readdirSync(jobsDir)).toEqual(['job_new.json']);
    });

    it('round-trips a handle through persist then load', async () => {
        // Given
        const jobsDir = makeTempDir();
        const handle = sampleHandle({
            jobId: 'job_full',
            status: 'completed',
            result: { status: 'completed', output: 'done' },
            completedAt: '2026-06-22T00:01:00.000Z',
        });

        // When
        await persistJob(jobsDir, handle);
        const loaded = await loadPersistedJobs(jobsDir);

        // Then
        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toEqual(handle);
    });

    it('round-trips a failed handle with its structured child failure', async () => {
        // Given
        const jobsDir = makeTempDir();
        const handle = sampleHandle({
            jobId: 'job_failed',
            status: 'failed',
            result: {
                status: 'failed',
                output: '[degraded salvage] partial child output',
                failure: {
                    code: 'provider_aborted',
                    message: 'remote provider closed the child stream',
                    retryable: false,
                },
            },
            completedAt: '2026-06-22T00:02:00.000Z',
        });

        // When
        await persistJob(jobsDir, handle);
        const loaded = await loadPersistedJobs(jobsDir);

        // Then
        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toEqual(handle);
    });
    it('rejects raw-error handles at the API and omits injected error text from disk', async () => {
        const expectFalse = <_Value extends false>(): void => undefined;
        expectFalse<BackgroundJobHandle extends DurableBackgroundJobHandle ? true : false>();

        const jobsDir = makeTempDir();
        const handle = sampleHandle({ jobId: 'job_raw_error' });
        const secret = 'file_persistence_secret';
        expect(Reflect.set(handle, 'error', secret)).toBe(true);

        await persistJob(jobsDir, handle);

        expect(readFileSync(join(jobsDir, 'job_raw_error.json'), 'utf8')).not.toContain(secret);
        expect((await loadPersistedJobs(jobsDir))[0]?.error).toBeUndefined();
    });
});

describe('loadPersistedJobs', () => {
    it('reads all *.json files in the jobs directory', async () => {
        // Given
        const jobsDir = makeTempDir();
        const a = sampleHandle({ jobId: 'job_a', sessionId: 's1' });
        const b = sampleHandle({ jobId: 'job_b', sessionId: 's2' });
        const c = sampleHandle({ jobId: 'job_c', sessionId: 's3' });
        await persistJob(jobsDir, a);
        await persistJob(jobsDir, b);
        await persistJob(jobsDir, c);

        // When
        const loaded = await loadPersistedJobs(jobsDir);

        // Then
        expect(loaded).toHaveLength(3);
        const ids = loaded.map((h) => h.jobId).sort();
        expect(ids).toEqual(['job_a', 'job_b', 'job_c']);
    });

    it('returns an empty array when the directory does not exist', async () => {
        // Given
        const jobsDir = join(makeTempDir(), 'missing');

        // When
        const loaded = await loadPersistedJobs(jobsDir);

        // Then
        expect(loaded).toEqual([]);
    });

    it('skips a broken JSON file and continues loading valid ones', async () => {
        // Given
        const jobsDir = makeTempDir();
        const valid = sampleHandle({ jobId: 'job_good' });
        await persistJob(jobsDir, valid);
        writeFileSync(join(jobsDir, 'job_bad.json'), '{ not valid json');

        // When
        const loaded = await loadPersistedJobs(jobsDir);

        // Then
        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.jobId).toBe('job_good');
    });

    it('skips a file that fails schema validation', async () => {
        // Given
        const jobsDir = makeTempDir();
        const valid = sampleHandle({ jobId: 'job_good' });
        await persistJob(jobsDir, valid);
        writeFileSync(join(jobsDir, 'job_bad.json'), JSON.stringify({ random: 'shape' }));

        // When
        const loaded = await loadPersistedJobs(jobsDir);

        // Then
        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.jobId).toBe('job_good');
    });

    it('ignores non-json files in the directory', async () => {
        // Given
        const jobsDir = makeTempDir();
        const valid = sampleHandle({ jobId: 'job_x' });
        await persistJob(jobsDir, valid);
        writeFileSync(join(jobsDir, 'notes.txt'), 'ignore me');
        writeFileSync(join(jobsDir, 'readme.md'), '# ignore');

        // When
        const loaded = await loadPersistedJobs(jobsDir);

        // Then
        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.jobId).toBe('job_x');
    });
});

describe('concurrent writes', () => {
    it('safely persists many jobs written in parallel without leftover temp files', async () => {
        // Given
        const jobsDir = makeTempDir();
        const handles: DurableBackgroundJobHandle[] = Array.from({ length: 10 }, (_, i) =>
            sampleHandle({ jobId: `job_${i}`, sessionId: `s_${i}` }),
        );

        // When
        await Promise.all(handles.map((h) => persistJob(jobsDir, h)));

        // Then
        const entries = readdirSync(jobsDir);
        expect(entries).toHaveLength(10);
        expect(entries.every((name) => name.endsWith('.json'))).toBe(true);
        const loaded = await loadPersistedJobs(jobsDir);
        expect(loaded).toHaveLength(10);
        const loadedIds = loaded.map((h) => h.jobId).sort();
        expect(loadedIds).toEqual(handles.map((h) => h.jobId).sort());
    });

    it('never leaves a partially-written file when overwriting the same jobId concurrently', async () => {
        // Given
        const jobsDir = makeTempDir();
        const jobId = 'job_contended';
        // All writes target the same jobId; each produces a valid handle.
        const handles: DurableBackgroundJobHandle[] = Array.from({ length: 5 }, (_, i) =>
            sampleHandle({ jobId, status: 'completed', sessionId: `s_${i}` }),
        );

        // When
        await Promise.all(handles.map((h) => persistJob(jobsDir, h)));

        // Then: exactly one file exists, it is valid JSON, and no temp files remain.
        const entries = readdirSync(jobsDir);
        expect(entries).toEqual([`${jobId}.json`]);
        const loaded = await loadPersistedJobs(jobsDir);
        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.jobId).toBe(jobId);
        expect(loaded[0]?.status).toBe('completed');
    });
});
