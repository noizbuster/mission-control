import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundJobHandle } from './async-job-manager.js';
import { loadPersistedJobs, persistJob } from './job-persistence.js';
import { recoverJobs } from './job-recovery.js';
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

function sampleHandle(overrides: Partial<BackgroundJobHandle> = {}): BackgroundJobHandle {
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

    it('stamps cancelled jobs with a salvage snippet and completion timestamp', async () => {
        // Given
        const jobsDir = makeTempDir();
        await persistJob(jobsDir, sampleHandle({ jobId: 'job_running', status: 'running' }));

        // When
        await recoverJobs(jobsDir);

        // Then: the cancelled job carries a salvage snippet in its error field
        const [loaded] = await loadPersistedJobs(jobsDir);
        expect(loaded?.status).toBe('cancelled');
        expect(loaded?.error).toBe('[cancelled after 0 req, (no output)]');
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

    it('preserves failed jobs', async () => {
        // Given
        const jobsDir = makeTempDir();
        await persistJob(
            jobsDir,
            sampleHandle({
                jobId: 'job_failed',
                status: 'failed',
                error: 'boom',
                completedAt: '2026-06-22T00:00:00.000Z',
            }),
        );

        // When
        const report = await recoverJobs(jobsDir);

        // Then
        expect(report).toEqual({ recovered: 1, cancelled: 0, preserved: 1 });
        const [loaded] = await loadPersistedJobs(jobsDir);
        expect(loaded?.status).toBe('failed');
        expect(loaded?.error).toBe('boom');
    });

    it('returns zero counts for a missing directory', async () => {
        // Given
        const missingDir = join(makeTempDir(), 'nope');

        // When
        const report = await recoverJobs(missingDir);

        // Then
        expect(report).toEqual({ recovered: 0, cancelled: 0, preserved: 0 });
    });
});
