import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import { AsyncJobCleanupError } from './async-job-manager.js';
import { ChildSessionCleanupError } from './task-tool-runtime-control.js';
import {
    abortListenerCounts,
    buildLifecycleRuntime,
    cleanupLifecycleHosts,
    createLifecycleHost,
    lifecycleRequest,
    makeLifecycleServices,
    resolvingMirror,
} from './task-tool-runtime-lifecycle-test-support.js';

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupLifecycleHosts();
});

describe('background child control errors', () => {
    it('surfaces child settlement rejection and still quiesces the host', async () => {
        const fixture = await createLifecycleHost('background-settle-reject');
        const settlementError = new Error('settlement rejected');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const epoch: SessionControlEpoch = {
            dbIdentity: 'a'.repeat(64),
            sessionId: 'parent-session',
            ownerId: 'owner',
            ownerEpoch: 1,
            callbackFence: {
                operationId: 'operation-background-settle',
                settle: async () => Promise.reject(settlementError),
            },
        };
        const services = makeLifecycleServices({
            host: fixture.host,
            mirror: resolvingMirror(),
            jobMirror: { recordJob: () => undefined },
        });
        const runtime = buildLifecycleRuntime(services, async (context) => ({
            sessionId: context.sessionId,
            status: 'completed',
            output: 'done',
        }));

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, controller.signal, epoch));
        const failure = await services.jobManager.awaitJob(handle.backgroundId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AsyncJobCleanupError);
        if (failure instanceof AsyncJobCleanupError) {
            expect(failure.primaryError).toBe(settlementError);
            expect(failure.suppressedErrors).toEqual([settlementError]);
        }
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('quiesces child control before a background job mirror rejects settlement', async () => {
        const fixture = await createLifecycleHost('background-mirror-reject');
        const mirrorError = new Error('job mirror rejected');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const services = makeLifecycleServices({
            host: fixture.host,
            jobMirror: {
                recordJob: (handle) =>
                    handle.status === 'queued' || handle.status === 'running' ? undefined : Promise.reject(mirrorError),
            },
        });
        const runtime = buildLifecycleRuntime(services, async (context) => ({
            sessionId: context.sessionId,
            status: 'completed',
            output: 'done',
        }));

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, controller.signal));
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toBe(mirrorError.message);
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('fails closed before fenced child settlement when the subagent mirror is missing', async () => {
        const fixture = await createLifecycleHost('background-missing-subagent-mirror');
        const settlementKinds: string[] = [];
        const epoch: SessionControlEpoch = {
            dbIdentity: 'b'.repeat(64),
            sessionId: 'parent-session',
            ownerId: 'owner',
            ownerEpoch: 2,
            callbackFence: {
                operationId: 'operation-background-missing-mirror',
                settle: async (input) => {
                    settlementKinds.push(input.handleKind);
                    return { accepted: true, allSettled: true };
                },
            },
        };
        const services = makeLifecycleServices({
            host: fixture.host,
            jobMirror: { recordJob: () => undefined },
        });
        const runtime = buildLifecycleRuntime(services, async (context) => ({
            sessionId: context.sessionId,
            status: 'completed',
            output: 'done',
        }));

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, undefined, epoch));
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toContain('durable mirror');
        expect(settlementKinds).toEqual(['job']);
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('preserves typed primary context when settlement and detach also reject', async () => {
        const fixture = await createLifecycleHost('background-dual-failure');
        const spawnError = new Error('spawn rejected');
        const settlementError = new Error('settlement rejected');
        const detachError = new Error('detach rejected');
        const epoch: SessionControlEpoch = {
            dbIdentity: 'c'.repeat(64),
            sessionId: 'parent-session',
            ownerId: 'owner',
            ownerEpoch: 3,
            callbackFence: {
                operationId: 'operation-background-dual-failure',
                settle: async () => Promise.reject(settlementError),
            },
        };
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
        const services = makeLifecycleServices({ host: fixture.host, mirror: resolvingMirror() });
        let execute: Parameters<typeof services.jobManager.startJob>[0]['execute'] | undefined;
        vi.spyOn(services.jobManager, 'startJob').mockImplementation((input) => {
            execute = input.execute;
            return {
                jobId: 'job-background-dual-failure',
                sessionId: input.sessionId,
                ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
                ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
                ...(input.blocking !== undefined ? { blocking: input.blocking } : {}),
                status: 'queued',
                startedAt: new Date().toISOString(),
                ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
            };
        });
        const runtime = buildLifecycleRuntime(services, async () => Promise.reject(spawnError));
        runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, undefined, epoch));
        const capturedExecute = execute;
        if (capturedExecute === undefined) throw new TypeError('background execute was not captured');

        const failure = await capturedExecute(new AbortController().signal, epoch).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ChildSessionCleanupError);
        if (failure instanceof ChildSessionCleanupError) {
            expect(failure.primaryError).toBe(spawnError);
            expect(failure.suppressedErrors).toEqual([settlementError, detachError]);
        }
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('preserves typed child cleanup errors through the production background job handle', async () => {
        const fixture = await createLifecycleHost('background-production-aggregate');
        const spawnError = new Error('spawn rejected');
        const settlementError = new Error('settlement rejected');
        const detachError = new Error('detach rejected');
        const epoch: SessionControlEpoch = {
            dbIdentity: 'd'.repeat(64),
            sessionId: 'parent-session',
            ownerId: 'owner',
            ownerEpoch: 4,
            callbackFence: {
                operationId: 'operation-background-production-aggregate',
                settle: async () => Promise.reject(settlementError),
            },
        };
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
        const services = makeLifecycleServices({
            host: fixture.host,
            mirror: resolvingMirror(),
        });
        const runtime = buildLifecycleRuntime(services, async () => Promise.reject(spawnError));

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, undefined, epoch));
        const failure = await services.jobManager.awaitJob(handle.backgroundId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AsyncJobCleanupError);
        if (failure instanceof AsyncJobCleanupError) {
            expect(failure.primaryError).toBe(spawnError);
            expect(failure.suppressedErrors.slice(0, 2)).toEqual([settlementError, detachError]);
            expect(failure.suppressedErrors[2]).toMatchObject({
                message: 'controlled job persistence mirror is required',
            });
        }
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('preserves the spawn failure when background job-control detach also rejects', async () => {
        const fixture = await createLifecycleHost('background-job-detach-aggregate');
        const spawnError = new Error('spawn rejected');
        const detachError = new Error('job detach rejected');
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(async (input) => {
            const attachment = await originalAttach(input);
            if (input.kind !== 'job') return attachment;
            return {
                detach: async () => {
                    await attachment.detach();
                    throw detachError;
                },
            };
        });
        const services = makeLifecycleServices({ host: fixture.host, controlJobs: true });
        const runtime = buildLifecycleRuntime(services, async () => Promise.reject(spawnError));

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId));
        const failure = await services.jobManager.awaitJob(handle.backgroundId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AsyncJobCleanupError);
        if (failure instanceof AsyncJobCleanupError) {
            expect(failure.primaryError).toBe(spawnError);
            expect(failure.suppressedErrors).toEqual([detachError]);
        }
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
        expect(fixture.host.classify('parent-session')).toEqual({ kind: 'absent' });
    });
});
