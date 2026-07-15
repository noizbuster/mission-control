import { describe, expect, it } from 'vitest';
import {
    buildRuntimeWithoutServices,
    buildRuntimeWithServices,
    makeBackgroundRequest,
    makeTaskRuntimeServices,
} from './task-tool-runtime-background-test-support.js';

describe('ConcreteTaskToolRuntime.startBackgroundSession', () => {
    describe('with injected services', () => {
        it('returns a handle with sessionId and backgroundId instead of throwing', () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'done',
            }));

            const handle = runtime.startBackgroundSession(makeBackgroundRequest('sess-bg-1'));

            expect(handle.sessionId).toBe('sess-bg-1');
            expect(handle.backgroundId).toMatch(/^job_\d+_[0-9a-f]{8}$/);
        });

        it('runs the spawn function through the AsyncJobManager and reaches completed', async () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'child finished',
            }));

            const handle = runtime.startBackgroundSession(makeBackgroundRequest('sess-bg-2'));
            const settled = await services.jobManager.awaitJob(handle.backgroundId);

            expect(settled.status).toBe('completed');
            expect(settled.result?.output).toBe('child finished');
        });

        it('registers the child as a running ref in the runtime registry', () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'done',
            }));

            runtime.startBackgroundSession(makeBackgroundRequest('sess-bg-3'));

            const ref = services.runtimeRegistry.lookup('sess-bg-3');
            expect(ref).toBeDefined();
            expect(ref?.status).toBe('running');
            expect(ref?.kind).toBe('sub');
            expect(ref?.parentId).toBe('parent-session');
            expect(runtime.sessionExists('sess-bg-3')).toBe(false);
        });

        it('surfaces child-agent failures through job state instead of swallowing them', async () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async () => {
                throw new Error('child exploded');
            });

            const handle = runtime.startBackgroundSession(makeBackgroundRequest('sess-bg-4'));
            const settled = await services.jobManager.awaitJob(handle.backgroundId);

            expect(settled.status).toBe('failed');
            expect(settled.error).toBe('child exploded');
        });

        it('transitions the ref to aborted when the spawn throws', async () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async () => {
                throw new Error('boom');
            });

            runtime.startBackgroundSession(makeBackgroundRequest('sess-bg-5'));
            await services.jobManager.awaitJob(
                services.jobManager.listJobs().find((j) => j.sessionId === 'sess-bg-5')?.jobId ?? '',
            );

            const ref = services.runtimeRegistry.lookup('sess-bg-5');
            expect(ref?.status).toBe('aborted');
        });

        it('transitions the ref to idle after a successful completion', async () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'ok',
            }));

            runtime.startBackgroundSession(makeBackgroundRequest('sess-bg-6'));
            const job = services.jobManager.listJobs().find((j) => j.sessionId === 'sess-bg-6');
            await services.jobManager.awaitJob(job?.jobId ?? '');

            const ref = services.runtimeRegistry.lookup('sess-bg-6');
            expect(ref?.status).toBe('idle');
            expect(runtime.sessionExists('sess-bg-6')).toBe(true);
        });

        it('runs multiple background sessions concurrently without cross-contamination', async () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async (sessionId) => ({
                status: 'completed',
                output: `output-for-${sessionId}`,
            }));

            const handle1 = runtime.startBackgroundSession(makeBackgroundRequest('sess-concurrent-1'));
            const handle2 = runtime.startBackgroundSession(makeBackgroundRequest('sess-concurrent-2'));

            expect(handle1.backgroundId).not.toBe(handle2.backgroundId);
            expect(handle1.sessionId).toBe('sess-concurrent-1');
            expect(handle2.sessionId).toBe('sess-concurrent-2');

            const [settled1, settled2] = await Promise.all([
                services.jobManager.awaitJob(handle1.backgroundId),
                services.jobManager.awaitJob(handle2.backgroundId),
            ]);

            expect(settled1.result?.output).toBe('output-for-sess-concurrent-1');
            expect(settled2.result?.output).toBe('output-for-sess-concurrent-2');
            expect(services.runtimeRegistry.lookup('sess-concurrent-1')?.status).toBe('idle');
            expect(services.runtimeRegistry.lookup('sess-concurrent-2')?.status).toBe('idle');
        });

        it('tracks sequential background sessions independently', async () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'done',
            }));

            const first = runtime.startBackgroundSession(makeBackgroundRequest('sess-seq-1'));
            await services.jobManager.awaitJob(first.backgroundId);
            expect(services.runtimeRegistry.lookup('sess-seq-1')?.status).toBe('idle');

            const second = runtime.startBackgroundSession(makeBackgroundRequest('sess-seq-2'));
            await services.jobManager.awaitJob(second.backgroundId);
            expect(services.runtimeRegistry.lookup('sess-seq-2')?.status).toBe('idle');

            expect(services.runtimeRegistry.lookup('sess-seq-1')?.status).toBe('idle');
        });

        it('transitions the ref to aborted when the spawn returns a failed status without throwing', async () => {
            const services = makeTaskRuntimeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'failed',
                output: 'child reported failure',
            }));

            const handle = runtime.startBackgroundSession(makeBackgroundRequest('sess-result-fail'));
            const settled = await services.jobManager.awaitJob(handle.backgroundId);

            expect(settled.status).toBe('failed');
            expect(settled.result?.output).toBe('child reported failure');
            expect(settled.error).toBeUndefined();
            expect(services.runtimeRegistry.lookup('sess-result-fail')?.status).toBe('aborted');
        });

        it('marks the job handle as cancelled when the job manager cancels a running job', async () => {
            const services = makeTaskRuntimeServices();
            let releaseSpawn: () => void = () => undefined;
            let markSpawnStarted: (() => void) | undefined;
            const spawnStarted = new Promise<void>((resolve) => {
                markSpawnStarted = resolve;
            });
            const runtime = buildRuntimeWithServices(
                services,
                () =>
                    new Promise<{ status: 'completed'; output: string }>((resolve) => {
                        markSpawnStarted?.();
                        releaseSpawn = () => resolve({ status: 'completed', output: 'late' });
                    }),
            );

            const handle = runtime.startBackgroundSession(makeBackgroundRequest('sess-cancel-run'));
            await spawnStarted;
            services.jobManager.cancelJob(handle.backgroundId);

            expect(services.jobManager.listJobs().find((job) => job.jobId === handle.backgroundId)?.status).toBe(
                'cancelled',
            );
            releaseSpawn();
            const settled = await services.jobManager.awaitJob(handle.backgroundId);
            expect(settled.status).toBe('cancelled');
        });
    });

    describe('without injected services', () => {
        it('throws not-yet-implemented (backward compatibility)', () => {
            const runtime = buildRuntimeWithoutServices();

            expect(() => runtime.startBackgroundSession(makeBackgroundRequest('sess-no-svc'))).toThrow(
                /not yet implemented/,
            );
        });

        it('does not register anything in a runtime registry', () => {
            const runtime = buildRuntimeWithoutServices();

            expect(() => runtime.startBackgroundSession(makeBackgroundRequest('sess-no-svc-2'))).toThrow();

            expect(runtime.sessionExists('sess-no-svc-2')).toBe(false);
        });
    });
});
