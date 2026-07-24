import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncJobCleanupError, AsyncJobManager, QuarantinedJobSettlementError } from './async-job-manager';
import { cleanupLifecycleHosts, createLifecycleHost } from './task-tool-runtime-lifecycle-test-support';

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupLifecycleHosts();
});

describe('AsyncJobManager control cleanup', () => {
    it('returns queued cancellation despite detach rejection and still drains the parent host', async () => {
        const fixture = await createLifecycleHost('job-queued-detach-reject');
        const detachError = new Error('queued detach rejected');
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        let jobAttachments = 0;
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(async (input) => {
            const attachment = await originalAttach(input);
            jobAttachments += 1;
            if (jobAttachments !== 2) return attachment;
            return {
                detach: async () => {
                    await attachment.detach();
                    throw detachError;
                },
            };
        });
        const manager = new AsyncJobManager(1, { sessionControlHost: fixture.host });
        let finishRunning: (() => void) | undefined;
        const running = manager.startJob({
            sessionId: 'running-child',
            parentSessionId: 'parent-session',
            execute: () =>
                new Promise((resolve) => {
                    finishRunning = () => resolve({ status: 'completed', output: 'done' });
                }),
        });
        const queuedExecute = vi.fn(async () => ({ status: 'completed' as const, output: 'must not run' }));
        const queued = manager.startJob({
            sessionId: 'queued-child',
            parentSessionId: 'parent-session',
            execute: queuedExecute,
        });
        await manager.drainPreparations();

        manager.cancelJob(queued.jobId);

        await expect(manager.awaitJob(queued.jobId)).resolves.toMatchObject({ status: 'cancelled' });
        expect(queuedExecute).not.toHaveBeenCalled();
        finishRunning?.();
        await manager.awaitJob(running.jobId);
        await manager.drain();
        expect(fixture.host.classify('parent-session')).toEqual({ kind: 'absent' });
    });

    it('preserves execution failure when fenced settlement and detach also reject', async () => {
        const fixture = await createLifecycleHost('job-execute-settle-detach-reject');
        const executionError = new Error('execution rejected');
        const settlementError = new Error('settlement rejected');
        const detachError = new Error('detach rejected');
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(async (input) => {
            const attachment = await originalAttach(input);
            return {
                detach: async () => {
                    await attachment.detach();
                    throw detachError;
                },
            };
        });
        const manager = new AsyncJobManager(1, {
            sessionControlHost: fixture.host,
            mirror: { recordJob: () => undefined },
        });
        const handle = manager.startJob({
            sessionId: 'failing-child',
            parentSessionId: 'parent-session',
            controlEpoch: {
                dbIdentity: 'a'.repeat(64),
                sessionId: 'parent-session',
                ownerId: 'owner',
                ownerEpoch: 1,
                callbackFence: {
                    operationId: 'operation-execute-settle-detach-reject',
                    settle: async () => Promise.reject(settlementError),
                },
            },
            execute: async () => Promise.reject(executionError),
        });

        const failure = await manager.awaitJob(handle.jobId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AsyncJobCleanupError);
        if (failure instanceof AsyncJobCleanupError) {
            expect(failure.primaryError).toBe(executionError);
            expect(failure.suppressedErrors).toEqual([settlementError, detachError]);
        }
        expect(fixture.host.classify('parent-session')).toEqual({ kind: 'absent' });
    });

    it('surfaces detach rejection as suppressed context after quarantine', async () => {
        const fixture = await createLifecycleHost('job-quarantine-detach-reject');
        const detachError = new Error('detach rejected');
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(async (input) => {
            const attachment = await originalAttach(input);
            return {
                detach: async () => {
                    await attachment.detach();
                    throw detachError;
                },
            };
        });
        const manager = new AsyncJobManager(1, {
            sessionControlHost: fixture.host,
            mirror: { recordJob: () => undefined },
        });
        const handle = manager.startJob({
            sessionId: 'stale-child',
            parentSessionId: 'parent-session',
            controlEpoch: {
                dbIdentity: 'b'.repeat(64),
                sessionId: 'parent-session',
                ownerId: 'owner',
                ownerEpoch: 2,
                callbackFence: {
                    operationId: 'operation-quarantine-detach-reject',
                    settle: async () => ({ accepted: false, allSettled: false }),
                },
            },
            execute: async () => ({ status: 'completed', output: 'stale' }),
        });

        const failure = await manager.awaitJob(handle.jobId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AsyncJobCleanupError);
        if (failure instanceof AsyncJobCleanupError) {
            expect(failure.primaryError).toBeInstanceOf(QuarantinedJobSettlementError);
            expect(failure.suppressedErrors).toEqual([detachError]);
        }
        expect(fixture.host.classify('parent-session')).toEqual({ kind: 'absent' });
    });

    it('notifies pre-start termination once and returns cancellation when attachment cleanup rejects', async () => {
        const fixture = await createLifecycleHost('job-pre-start-notify-once');
        const detachError = new Error('detach rejected');
        let finishAttach: ((attachment: { readonly detach: () => Promise<void> }) => void) | undefined;
        vi.spyOn(fixture.host, 'attachEntity').mockReturnValue(
            new Promise((resolve) => {
                finishAttach = resolve;
            }),
        );
        const onTerminatedBeforeStart = vi.fn();
        const manager = new AsyncJobManager(1, { sessionControlHost: fixture.host });
        const handle = manager.startJob({
            sessionId: 'queued-child',
            parentSessionId: 'parent-session',
            onTerminatedBeforeStart,
            execute: async () => ({ status: 'completed', output: 'must not run' }),
        });

        manager.cancelJob(handle.jobId);
        finishAttach?.({ detach: async () => Promise.reject(detachError) });
        await expect(manager.awaitJob(handle.jobId)).resolves.toMatchObject({ status: 'cancelled' });
        expect(onTerminatedBeforeStart).toHaveBeenCalledTimes(1);
    });

    it('returns a durably completed handle when control detach rejects', async () => {
        const fixture = await createLifecycleHost('job-complete-detach-reject');
        const detachError = new Error('detach rejected');
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(async (input) => {
            const attachment = await originalAttach(input);
            return {
                detach: async () => {
                    await attachment.detach();
                    throw detachError;
                },
            };
        });
        const terminalWrites: string[] = [];
        const manager = new AsyncJobManager(1, {
            sessionControlHost: fixture.host,
            mirror: {
                recordJob: (handle) => {
                    if (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'cancelled') {
                        terminalWrites.push(handle.status);
                    }
                },
            },
        });
        const handle = manager.startJob({
            sessionId: 'completed-child',
            parentSessionId: 'parent-session',
            execute: async () => ({ status: 'completed', output: 'done' }),
        });

        await expect(manager.awaitJob(handle.jobId)).resolves.toMatchObject({
            status: 'completed',
            result: { output: 'done' },
        });

        expect(handle.status).toBe('completed');
        expect(terminalWrites).toEqual(['completed']);
        expect(fixture.host.classify('parent-session')).toEqual({ kind: 'absent' });
    });
});
