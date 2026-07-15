import type { PolicyEffectRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { buildChildPermissions } from '../tools/task/task-tool-routing.js';
import {
    buildRuntimeWithServices,
    makeBackgroundRequest,
    makeTaskRuntimeServices,
} from './task-tool-runtime-background-test-support.js';
import {
    advertisedChildToolNames,
    allowAllChildPermissions,
    buildPermissionRuntime,
    makePermissionAgent,
    makePermissionRequest,
    makePermissionTool,
} from './task-tool-runtime-permissions-test-support.js';

describe('ConcreteTaskToolRuntime child authority', () => {
    it('enforces the parent agent spawn allowlist', async () => {
        const { runtime } = buildPermissionRuntime(
            makePermissionAgent(),
            makePermissionAgent({ name: 'parent-agent', spawns: [] }),
        );

        await expect(runtime.runChildSession(makePermissionRequest([]))).rejects.toThrow(/parent spawns/);
    });

    it('intersects the live child surface with the child agent tool allowlist', async () => {
        const { runtime, contexts } = buildPermissionRuntime(makePermissionAgent({ tools: ['read'] }));

        await runtime.runChildSession(makePermissionRequest([]));

        const toolNames = advertisedChildToolNames(contexts[0]);
        expect(toolNames).toContain('read');
        expect(toolNames).toContain('yield');
        expect(toolNames).not.toContain('command.run');
    });

    it('rebuilds the same denied child surface when resuming a session', async () => {
        const { runtime, contexts } = buildPermissionRuntime();
        const permissions: readonly PolicyEffectRule[] = [
            ...allowAllChildPermissions,
            { action: 'write', resource: '**', effect: 'deny' },
        ];
        const request = makePermissionRequest(permissions);

        await runtime.runChildSession(request);
        await runtime.resumeChildSession(request.sessionId, request);

        const names = advertisedChildToolNames(contexts[1]);
        expect(names).toContain('repo.read');
        expect(names).not.toContain('file.write');
    });

    it('treats recursion -1 as metadata without restoring task or job authority', async () => {
        const { runtime, contexts } = buildPermissionRuntime(
            makePermissionAgent({ recursion: -1, tools: ['read', 'task', 'job'] }),
        );
        const childPermissions = buildChildPermissions(undefined);

        await runtime.runChildSession(makePermissionRequest(childPermissions));

        const names = advertisedChildToolNames(contexts[0]);
        expect(names).toContain('read');
        expect(names).toContain('yield');
        expect(names).not.toContain('task');
        expect(names).not.toContain('job');
        expect(childPermissions.at(-1)).toEqual({ action: 'subagent', resource: '**', effect: 'deny' });
    });

    it('rejects resume when the effective parent tool surface changed', async () => {
        const { runtime, parentToolRegistry, executed } = buildPermissionRuntime();
        const request = makePermissionRequest(allowAllChildPermissions);
        await runtime.runChildSession(request);
        parentToolRegistry.register(makePermissionTool('new-parent-tool', ['read'], executed));

        await expect(runtime.resumeChildSession(request.sessionId, request)).rejects.toThrow(/authority/);
    });

    it('does not expose a foreign child session for resume', () => {
        const services = makeTaskRuntimeServices();
        const runtime = buildRuntimeWithServices(services, async () => ({ status: 'completed', output: 'done' }));
        services.runtimeRegistry.adopt({
            id: 'foreign-child',
            displayName: 'foreign',
            kind: 'sub',
            parentId: 'other-parent',
            status: 'idle',
            sessionId: 'foreign-child',
        });

        expect(runtime.sessionExists('foreign-child')).toBe(false);
    });

    it('rejects authority-changing and stopped-session resumes', async () => {
        const services = makeTaskRuntimeServices();
        const runtime = buildRuntimeWithServices(services, async () => ({ status: 'completed', output: 'done' }));
        const request = makeBackgroundRequest('sess-resume-authority');

        await runtime.runChildSession(request);
        await expect(
            runtime.resumeChildSession('sess-resume-authority', {
                ...request,
                childPermissions: [{ action: 'write', resource: '**', effect: 'deny' }],
            }),
        ).rejects.toThrow(/authority/);

        services.runtimeRegistry.update('sess-resume-authority', { status: 'aborted' });
        expect(runtime.sessionExists('sess-resume-authority')).toBe(false);
        await expect(runtime.resumeChildSession('sess-resume-authority', request)).rejects.toThrow(/not resumable/);
    });
});
