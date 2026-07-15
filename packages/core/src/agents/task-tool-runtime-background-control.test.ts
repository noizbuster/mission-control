import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation';
import { AsyncJobCleanupError, QuarantinedJobSettlementError } from './async-job-manager';
import {
    abortListenerCounts,
    buildLifecycleRuntime,
    cleanupLifecycleHosts,
    createLifecycleHost,
    lifecycleRequest,
    makeLifecycleServices,
} from './task-tool-runtime-lifecycle-test-support';

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupLifecycleHosts();
});

describe('background job control lifecycle', () => {
    it('settles the adopted ref when background job-control attachment rejects before child execution', async () => {
        const fixture = await createLifecycleHost('background-job-attach-reject');
        const attachError = new Error('job attach rejected');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        vi.spyOn(fixture.host, 'attachEntity').mockRejectedValue(attachError);
        const services = makeLifecycleServices({ host: fixture.host, controlJobs: true });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'late',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, controller.signal));
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toBe(attachError.message);
        expect(spawn).not.toHaveBeenCalled();
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('fences controlled job attachment rejection before settling the adopted ref', async () => {
        const fixture = await createLifecycleHost('background-controlled-job-attach-reject');
        const attachError = new Error('controlled job attach rejected');
        const settlementKinds: string[] = [];
        const epoch: SessionControlEpoch = {
            dbIdentity: 'f'.repeat(64),
            sessionId: 'parent-session',
            ownerId: 'owner',
            ownerEpoch: 6,
            callbackFence: {
                operationId: 'operation-background-controlled-attach',
                settle: async (input) => {
                    settlementKinds.push(input.handleKind);
                    return { accepted: true, allSettled: true };
                },
            },
        };
        vi.spyOn(fixture.host, 'attachEntity').mockRejectedValue(attachError);
        const services = makeLifecycleServices({
            host: fixture.host,
            controlJobs: true,
            jobMirror: { recordJob: () => undefined },
        });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'late',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, undefined, epoch));
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(settled.status).toBe('failed');
        expect(spawn).not.toHaveBeenCalled();
        expect(settlementKinds).toEqual(['job']);
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
    });

    it('detaches job control when background activation mirror throws after attachment', async () => {
        const fixture = await createLifecycleHost('background-activation-reject');
        const mirrorError = new Error('queued mirror rejected');
        const services = makeLifecycleServices({
            host: fixture.host,
            controlJobs: true,
            jobMirror: {
                recordJob: () => {
                    throw mirrorError;
                },
            },
        });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'late',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId));
        const settled = await services.jobManager.awaitJob(handle.backgroundId);
        await services.jobManager.drain();

        expect(settled.status).toBe('failed');
        expect(settled.error).toBe(mirrorError.message);
        expect(spawn).not.toHaveBeenCalled();
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
        expect(fixture.host.classify('parent-session')).toEqual({ kind: 'absent' });
    });

    it('does not start a controlled child cancelled while job attachment is pending', async () => {
        const fixture = await createLifecycleHost('background-pending-attach-cancel');
        let finishAttach: ((attachment: { readonly detach: () => Promise<void> }) => void) | undefined;
        const attachment = new Promise<{ readonly detach: () => Promise<void> }>((resolve) => {
            finishAttach = resolve;
        });
        const detach = vi.fn(async () => undefined);
        vi.spyOn(fixture.host, 'attachEntity').mockReturnValue(attachment);
        let finishSettlement: (() => void) | undefined;
        const settlement = new Promise<{ readonly accepted: true; readonly allSettled: true }>((resolve) => {
            finishSettlement = () => resolve({ accepted: true, allSettled: true });
        });
        const epoch: SessionControlEpoch = {
            dbIdentity: 'e'.repeat(64),
            sessionId: 'parent-session',
            ownerId: 'owner',
            ownerEpoch: 5,
            callbackFence: {
                operationId: 'operation-background-pending-attach',
                settle: () => settlement,
            },
        };
        const services = makeLifecycleServices({
            host: fixture.host,
            controlJobs: true,
            jobMirror: { recordJob: () => undefined },
        });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'must not run',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);
        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, undefined, epoch));

        services.jobManager.cancelJob(handle.backgroundId, 'operator_aborted');
        finishAttach?.({ detach });
        await services.jobManager.drainPreparations();

        expect(spawn).not.toHaveBeenCalled();
        finishSettlement?.();
        const settled = await services.jobManager.awaitJob(handle.backgroundId);
        await services.jobManager.drain();
        expect(settled.status).toBe('cancelled');
        expect(detach).toHaveBeenCalledTimes(1);
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
    });

    it('rejects awaiters when controlled attachment failure is quarantined', async () => {
        const fixture = await createLifecycleHost('background-controlled-attach-quarantine');
        const attachError = new Error('attach rejected');
        vi.spyOn(fixture.host, 'attachEntity').mockRejectedValue(attachError);
        const epoch: SessionControlEpoch = {
            dbIdentity: '9'.repeat(64),
            sessionId: 'parent-session',
            ownerId: 'owner',
            ownerEpoch: 7,
            callbackFence: {
                operationId: 'operation-background-attach-quarantine',
                settle: async () => ({ accepted: false, allSettled: false }),
            },
        };
        const services = makeLifecycleServices({
            host: fixture.host,
            controlJobs: true,
            jobMirror: { recordJob: () => undefined },
        });
        const runtime = buildLifecycleRuntime(services, async (context) => ({
            sessionId: context.sessionId,
            status: 'completed',
            output: 'must not run',
        }));

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, undefined, epoch));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const observed = await Promise.race([
            services.jobManager.awaitJob(handle.backgroundId).catch((error: unknown) => error),
            new Promise<string>((resolve) => {
                timeout = setTimeout(() => resolve('timed out'), 100);
            }),
        ]);
        if (timeout !== undefined) clearTimeout(timeout);

        expect(observed).toBeInstanceOf(AsyncJobCleanupError);
        if (observed instanceof AsyncJobCleanupError) {
            expect(observed.primaryError).toBe(attachError);
            expect(observed.suppressedErrors[0]).toBeInstanceOf(QuarantinedJobSettlementError);
        }
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('running');
    });
});
