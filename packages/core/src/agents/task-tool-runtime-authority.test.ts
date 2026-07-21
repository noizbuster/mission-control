import type { PolicyEffectRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { buildChildPermissions } from '../tools/task/task-tool-routing';
import { PRODUCTION_MAX_TASK_DEPTH } from './recursion-policy';
import {
    buildRuntimeWithServices,
    makeBackgroundRequest,
    makeTaskRuntimeServices,
} from './task-tool-runtime-background-test-support';
import {
    advertisedChildToolNames,
    allowAllChildPermissions,
    buildPermissionRuntime,
    makePermissionAgent,
    makePermissionRequest,
    makePermissionTool,
} from './task-tool-runtime-permissions-test-support';
import { childAuthorityFingerprint } from './task-tool-runtime-authority';
import { ConcreteTaskToolRuntime } from './task-tool-runtime';
import { AgentIndex } from './agent-registry';
import { ToolRegistry } from '../tools/tool-registry';
import { MAIN_AGENT_ID } from './runtime-registry';

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

    it('treats recursion -1 as metadata; depth gate (not recursion) controls nested task', async () => {
        const { runtime, contexts } = buildPermissionRuntime(
            makePermissionAgent({ recursion: -1, tools: ['read', 'task', 'job'] }),
        );
        const childPermissions = buildChildPermissions(undefined);

        await runtime.runChildSession(makePermissionRequest(childPermissions));

        const names = advertisedChildToolNames(contexts[0]);
        expect(names).toContain('read');
        expect(names).toContain('yield');
        expect(names).toContain('task');
        expect(names).toContain('job');
        expect(childPermissions.at(-1)).toEqual({ action: 'subagent', resource: '**', effect: 'deny' });
        expect(contexts[0]?.childPermissions.some((r) => r.action === 'subagent' && r.effect === 'deny')).toBe(
            false,
        );
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

    it('allows nested task on depth-allowed surfaces and stamps child taskDepth', async () => {
        const { runtime, contexts } = buildPermissionRuntime();
        await runtime.runChildSession(makePermissionRequest(allowAllChildPermissions));

        const names = advertisedChildToolNames(contexts[0]);
        expect(names).toContain('task');
        expect(contexts[0]?.childPermissions.some((r) => r.action === 'subagent' && r.effect === 'deny')).toBe(false);
        expect(PRODUCTION_MAX_TASK_DEPTH).toBe(3);
    });

    it('childAuthorityFingerprint includes taskDepth and PRODUCTION_MAX_TASK_DEPTH', () => {
        // Given identical authority inputs that differ only by taskDepth
        const parentToolRegistry = new ToolRegistry();
        parentToolRegistry.register(makePermissionTool('repo.read', ['repo.read'], { value: 0 }));
        const childToolRegistry = new ToolRegistry();
        childToolRegistry.register(makePermissionTool('repo.read', ['repo.read'], { value: 0 }));
        const agent = makePermissionAgent();
        const base = {
            parentToolRegistry,
            parentAgent: makePermissionAgent({ name: 'parent-agent', spawns: '*' }),
            parentSessionId: MAIN_AGENT_ID,
            workspaceRoot: '/tmp/workspace',
            agent,
            model: { providerID: 'test', modelID: 'model' },
            systemPrompt: 'Act as child.',
            childToolRegistry,
        } as const;
        const requestAt = (taskDepth: number) => ({
            sessionId: 'sess-fp',
            prompt: 'work',
            loadSkills: [] as const,
            childPermissions: allowAllChildPermissions,
            taskDepth,
        });

        // When
        const depth1 = childAuthorityFingerprint({ ...base, request: requestAt(1) });
        const depth2 = childAuthorityFingerprint({ ...base, request: requestAt(2) });
        const depth1Again = childAuthorityFingerprint({ ...base, request: requestAt(1) });

        // Then
        expect(depth1).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(depth1).toBe(depth1Again);
        expect(depth1).not.toBe(depth2);
        expect(PRODUCTION_MAX_TASK_DEPTH).toBe(3);
    });

    it('blocks nested task at PRODUCTION_MAX_TASK_DEPTH and keeps nested-subagent deny', async () => {
        const services = makeTaskRuntimeServices();
        services.runtimeRegistry.adopt({
            id: 'parent-at-depth-2',
            displayName: 'mid',
            kind: 'sub',
            parentId: MAIN_AGENT_ID,
            taskDepth: 2,
            status: 'idle',
            sessionId: 'parent-at-depth-2',
        });

        const agentIndex = new AgentIndex();
        agentIndex.register(makePermissionAgent());
        const parentToolRegistry = new ToolRegistry();
        parentToolRegistry.register(makePermissionTool('repo.read', ['repo.read'], { value: 0 }));
        parentToolRegistry.register(makePermissionTool('task', ['subagent'], { value: 0 }));
        parentToolRegistry.register(makePermissionTool('job', ['subagent'], { value: 0 }));

        const contexts: { names: readonly string[]; permissions: readonly PolicyEffectRule[] }[] = [];
        const runtime = new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel: () => ({ providerID: 'test', modelID: 'test-model' }),
            workspaceRoot: '/tmp/workspace',
            parentToolRegistry,
            parentAgent: makePermissionAgent({ name: 'parent-agent', spawns: '*' }),
            parentSessionId: 'parent-at-depth-2',
            services,
            spawnFn: async (context) => {
                contexts.push({
                    names: context.childToolRegistry.advertise().map((t) => t.name),
                    permissions: context.childPermissions,
                });
                return { sessionId: context.sessionId, status: 'completed', output: 'ok' };
            },
        });

        const request = makePermissionRequest([
            ...allowAllChildPermissions,
            { action: 'subagent', resource: '**', effect: 'deny' },
        ]);
        await runtime.runChildSession(request);

        expect(contexts[0]?.names).not.toContain('task');
        expect(contexts[0]?.names).not.toContain('job');
        expect(contexts[0]?.permissions.some((r) => r.action === 'subagent' && r.effect === 'deny')).toBe(true);
        expect(services.runtimeRegistry.lookup(request.sessionId)?.taskDepth).toBe(3);
    });

    it('nested runtime parentSessionId and parentAgent are the intermediate child', async () => {
        const services = makeTaskRuntimeServices();
        const agentIndex = new AgentIndex();
        agentIndex.register(makePermissionAgent({ name: 'mid-agent', spawns: '*' }));
        agentIndex.register(makePermissionAgent({ name: 'leaf-agent', spawns: '*' }));

        const parentToolRegistry = new ToolRegistry();
        parentToolRegistry.register(makePermissionTool('repo.read', ['repo.read'], { value: 0 }));
        parentToolRegistry.register(makePermissionTool('task', ['subagent'], { value: 0 }));

        const spawnChain: { sessionId: string; hasTask: boolean; agentName: string }[] = [];
        const rootRuntime = new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel: () => ({ providerID: 'test', modelID: 'model' }),
            workspaceRoot: '/tmp/workspace',
            parentToolRegistry,
            parentAgent: makePermissionAgent({ name: 'root-agent', spawns: '*' }),
            parentSessionId: MAIN_AGENT_ID,
            services,
            spawnFn: async (context) => {
                spawnChain.push({
                    sessionId: context.sessionId,
                    hasTask: context.childToolRegistry.advertise().some((t) => t.name === 'task'),
                    agentName: context.agent.name,
                });
                return { sessionId: context.sessionId, status: 'completed', output: 'done' };
            },
        });

        await rootRuntime.runChildSession({
            sessionId: 'mid-session',
            prompt: 'mid work',
            loadSkills: [],
            childPermissions: allowAllChildPermissions,
            subagentType: 'mid-agent',
        });

        expect(spawnChain[0]?.agentName).toBe('mid-agent');
        expect(spawnChain[0]?.hasTask).toBe(true);
        expect(services.runtimeRegistry.lookup('mid-session')?.taskDepth).toBe(1);
        expect(services.runtimeRegistry.lookup('mid-session')?.parentId).toBe(MAIN_AGENT_ID);

        const midRef = services.runtimeRegistry.lookup('mid-session');
        expect(midRef).toBeDefined();
        services.runtimeRegistry.update('mid-session', { status: 'idle' });

        const midSurface = spawnChain[0];
        expect(midSurface?.hasTask).toBe(true);

        const midParentRegistry = new ToolRegistry();
        midParentRegistry.register(makePermissionTool('repo.read', ['repo.read'], { value: 0 }));
        const midRuntime = new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel: () => ({ providerID: 'test', modelID: 'model' }),
            workspaceRoot: '/tmp/workspace',
            parentToolRegistry: midParentRegistry,
            parentAgent: makePermissionAgent({ name: 'mid-agent', spawns: '*' }),
            parentSessionId: 'mid-session',
            services,
            spawnFn: async (context) => {
                spawnChain.push({
                    sessionId: context.sessionId,
                    hasTask: context.childToolRegistry.advertise().some((t) => t.name === 'task'),
                    agentName: context.agent.name,
                });
                return { sessionId: context.sessionId, status: 'completed', output: 'leaf' };
            },
        });

        await midRuntime.runChildSession({
            sessionId: 'leaf-session',
            prompt: 'leaf work',
            loadSkills: [],
            childPermissions: allowAllChildPermissions,
            subagentType: 'leaf-agent',
        });

        expect(spawnChain[1]?.agentName).toBe('leaf-agent');
        expect(spawnChain[1]?.hasTask).toBe(true);
        expect(services.runtimeRegistry.lookup('leaf-session')?.taskDepth).toBe(2);
        expect(services.runtimeRegistry.lookup('leaf-session')?.parentId).toBe('mid-session');
    });
});
