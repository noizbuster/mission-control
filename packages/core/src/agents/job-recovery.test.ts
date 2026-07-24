import { afterEach, describe, expect, it } from 'vitest';
import type { DurableBackgroundJobHandle } from './async-job-manager';
import { loadPersistedJobs, persistJob } from './job-persistence';
import { recoverJobs } from './job-recovery';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'omo-recovery-'));
    tempDirs.push(dir);
    return dir;
}

function sampleHandle(overrides: Partial<DurableBackgroundJobHandle> = {}): DurableBackgroundJobHandle {
    return {
        jobId: 'job_test',
        sessionId: 'ses_1',
        status: 'running',
        startedAt: '2026-06-22T00:00:00.000Z',
        ...overrides,
    };
}

describe('recoverJobs', () => {
    it('marks running and queued jobs as cancelled and preserves completed jobs', async () => {
        // Given: 3 active + 2 completed jobs persisted to disk
        const jobsDir = makeTempDir();
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_r1', status: 'running' }));
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_q1', status: 'queued' }));
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_r2', status: 'running' }));
        await persistJob(
            jobsDir,
            sampleHandle({
                jobId: 'job_c1',
                status: 'completed',
                result: { status: 'completed', output: 'done' },
                completedAt: '2026-06-22T00:01:00.000Z',
            }),
        );
        await persistJob(
            jobsDir,
            sampleHandle({
                jobId: 'job_c2',
                status: 'completed',
                result: { status: 'completed', output: 'done2' },
                completedAt: '2026-06-22T00:02:00.000Z',
            }),
        );

        // When
        const report = await recoverJobs(jobsDir);

        // Then: report counts are correct
        expect(report).toEqual({ recovered: 5, cancelled: 3, preserved: 2 });

        // And: the 3 active jobs are now cancelled on disk
        const reloaded = await loadPersistedJobs(jobsDir);
        const byId = new Map(reloaded.map((h) => [h.jobId, h]));
        expect(byId.get('job_r1')?.status).toBe('cancelled');
        expect(byId.get('job_q1')?.status).toBe('cancelled');
        expect(byId.get('job_r2')?.status).toBe('cancelled');
        // And: the 2 completed jobs are unchanged
        expect(byId.get('job_c1')?.status).toBe('completed');
        expect(byId.get('job_c2')?.status).toBe('completed');
    });

    it('stamps cancelled jobs with a completion timestamp without serializing salvage text', async () => {
        // Given
        const jobsDir = makeTempDir();
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_running', status: 'running' }));

        // When
        await recoverJobs(jobsDir);

        // Then: cancellation is structural, not a model-visible error string.
        const [loaded] = await loadPersistedJobs(jobsDir);
        expect(loaded?.status).toBe('cancelled');
        expect(loaded?.error).toBeUndefined();
        expect(loaded?.completedAt).toBeDefined();
    });

    it('skips broken files and continues recovering valid ones', async () => {
        // Given: one valid running job plus a corrupt JSON file
        const jobsDir = makeTempDir();
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_good', status: 'running' }));
        writeFileSync(join(jobsDir, 'job_broken.json'), '{ not valid json');

        // When
        const report = await recoverJobs(jobsDir);

        // Then: only the valid job was recovered and cancelled
        expect(report).toEqual({ recovered: 1, cancelled: 1, preserved: 0 });
        const [loaded] = await loadPersistedJobs(jobsDir);
        expect(loaded?.jobId).toBe('job_good');
        expect(loaded?.status).toBe('cancelled');
    });

    it('preserves already-cancelled jobs without re-stamping them', async () => {
        // Given
        const jobsDir = makeTempDir();
        await persistJob(
            jobsDir,
            sampleHandle({
                jobId: 'job_cancelled',
                status: 'cancelled',
                completedAt: '2026-06-22T00:00:00.000Z',
            }),
        );

        // When
        const report = await recoverJobs(jobsDir);

        // Then: counted as preserved, file untouched
        expect(report).toEqual({ recovered: 1, cancelled: 0, preserved: 1 });
        const [loaded] = await loadPersistedJobs(jobsDir);
        expect(loaded?.status).toBe('cancelled');
        expect(loaded?.error).toBeUndefined();
    });

    it('preserves failed jobs with structured terminal failure details', async () => {
        // Given
        const jobsDir = makeTempDir();
        await persistJob(
            jobsDir,
            sampleHandle({
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
                completedAt: '2026-06-22T00:00:00.000Z',
            }),
        );

        // When
        const report = await recoverJobs(jobsDir);

        // Then
        expect(report).toEqual({ recovered: 1, cancelled: 0, preserved: 1 });
        const [loaded] = await loadPersistedJobs(jobsDir);
        expect(loaded).toMatchObject({
            status: 'failed',
            result: { failure: { code: 'provider_aborted', retryable: false } },
        });
    });

    it('returns zero counts for a missing directory', async () => {
        // Given
        const missingDir = join(makeTempDir(), 'nope');

        // When
        const report = await recoverJobs(missingDir);

        // Then
        expect(report).toEqual({ recovered: 0, cancelled: 0, preserved: 0 });
    });

    it('is idempotent: a second recoverJobs call preserves all jobs unchanged', async () => {
        // Given: 2 active jobs + 1 completed
        const jobsDir = makeTempDir();
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_a', status: 'running' }));
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_b', status: 'queued' }));
        await persistJob(
            jobsDir,
            sampleHandle({
                jobId: 'job_c',
                status: 'completed',
                result: { status: 'completed', output: 'done' },
                completedAt: '2026-06-22T00:01:00.000Z',
            }),
        );

        // When: first recovery
        const firstReport = await recoverJobs(jobsDir);
        expect(firstReport).toEqual({ recovered: 3, cancelled: 2, preserved: 1 });

        // When: second recovery — all jobs are now terminal
        const secondReport = await recoverJobs(jobsDir);

        // Then: nothing was re-cancelled or re-executed
        expect(secondReport).toEqual({ recovered: 3, cancelled: 0, preserved: 3 });
    });

    it('does not auto-reexecute: no new job files created after recovery', async () => {
        // Given
        const jobsDir = makeTempDir();
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_active', status: 'running' }));

        // When
        const { readdir } = await import('node:fs/promises');
        const filesBefore = (await readdir(jobsDir)).length;
        await recoverJobs(jobsDir);
        const filesAfter = (await readdir(jobsDir)).length;

        // Then: same number of files — recovery modifies in-place, never creates new jobs
        expect(filesAfter).toBe(filesBefore);

        // And: the recovered job is cancelled (not running)
        const [loaded] = await loadPersistedJobs(jobsDir);
        expect(loaded?.status).toBe('cancelled');
    });
});
