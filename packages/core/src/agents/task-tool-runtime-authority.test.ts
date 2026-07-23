import type { PolicyEffectRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { buildChildPermissions } from '../tools/task/task-tool-routing';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolExecutionError } from '../tools/tool-registry-types';
import { AgentIndex } from './agent-registry';
import { PRODUCTION_MAX_TASK_DEPTH } from './recursion-policy';
import { MAIN_AGENT_ID } from './runtime-registry';
import { type ChildSpawnContext, ConcreteTaskToolRuntime } from './task-tool-runtime';
import { childAuthorityFingerprint } from './task-tool-runtime-authority';
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

function buildNonRootDepthRuntime(input: {
    readonly parentSessionId: string;
    readonly services: ReturnType<typeof makeTaskRuntimeServices>;
}): {
    readonly runtime: ConcreteTaskToolRuntime;
    readonly contexts: ChildSpawnContext[];
} {
    const agentIndex = new AgentIndex();
    agentIndex.register(makePermissionAgent());
    const executed = { value: 0 };
    const parentToolRegistry = new ToolRegistry();
    parentToolRegistry.register(makePermissionTool('task', ['subagent'], executed));
    parentToolRegistry.register(makePermissionTool('job', ['subagent'], executed));
    const contexts: ChildSpawnContext[] = [];
    return {
        runtime: new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel: () => ({ providerID: 'test', modelID: 'test-model' }),
            workspaceRoot: '/tmp/workspace',
            parentToolRegistry,
            parentAgent: makePermissionAgent({ name: 'parent-agent', spawns: '*' }),
            parentSessionId: input.parentSessionId,
            services: input.services,
            spawnFn: async (context) => {
                contexts.push(context);
                return { sessionId: context.sessionId, status: 'completed', output: 'complete' };
            },
        }),
        contexts,
    };
}

async function expectNonRetryableTaskRejection(action: Promise<unknown>): Promise<void> {
    const error = await action.then(
        () => undefined,
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toMatchObject({ error: { code: 'tool_failed', retryable: false } });
}

async function invokeNestedTask(childToolRegistry: ToolRegistry, toolCallId: string, agent: string): Promise<void> {
    const task = childToolRegistry.advertise().find((advertisement) => advertisement.name === 'task');
    if (task === undefined) throw new Error('nested task tool was not registered');
    await childToolRegistry.invoke({
        toolCallId,
        toolName: task.name,
        advertisedVersion: task.version,
        argumentsJson: JSON.stringify({ agent, assignment: 'perform nested work', load_skills: [] }),
    });
}

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
        expect(contexts[0]?.childPermissions.some((r) => r.action === 'subagent' && r.effect === 'deny')).toBe(false);
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

    it('rejects an unknown non-root parent before spawning', async () => {
        // Given
        const services = makeTaskRuntimeServices();
        const { runtime, contexts } = buildNonRootDepthRuntime({
            parentSessionId: 'unknown-parent',
            services,
        });
        const request = { ...makePermissionRequest(allowAllChildPermissions), sessionId: 'unknown-child' };

        // When
        const action = runtime.runChildSession(request);

        // Then
        await expectNonRetryableTaskRejection(action);
        expect(contexts).toEqual([]);
        expect(services.runtimeRegistry.lookup(request.sessionId)).toBeUndefined();
    });

    it('rejects a registered non-root parent without taskDepth before spawning', async () => {
        // Given
        const services = makeTaskRuntimeServices();
        services.runtimeRegistry.adopt({
            id: 'incomplete-parent',
            displayName: 'incomplete parent',
            kind: 'sub',
            parentId: MAIN_AGENT_ID,
            status: 'idle',
            sessionId: 'incomplete-parent',
        });
        const { runtime, contexts } = buildNonRootDepthRuntime({
            parentSessionId: 'incomplete-parent',
            services,
        });
        const request = { ...makePermissionRequest(allowAllChildPermissions), sessionId: 'incomplete-child' };

        // When
        const action = runtime.runChildSession(request);

        // Then
        await expectNonRetryableTaskRejection(action);
        expect(contexts).toEqual([]);
        expect(services.runtimeRegistry.lookup(request.sessionId)).toBeUndefined();
    });

    it('rejects a child depth above PRODUCTION_MAX_TASK_DEPTH before spawning', async () => {
        // Given
        const services = makeTaskRuntimeServices();
        services.runtimeRegistry.adopt({
            id: 'leaf-parent',
            displayName: 'leaf parent',
            kind: 'sub',
            parentId: MAIN_AGENT_ID,
            taskDepth: PRODUCTION_MAX_TASK_DEPTH,
            status: 'idle',
            sessionId: 'leaf-parent',
        });
        const { runtime, contexts } = buildNonRootDepthRuntime({
            parentSessionId: 'leaf-parent',
            services,
        });
        const request = { ...makePermissionRequest(allowAllChildPermissions), sessionId: 'over-depth-child' };

        // When
        const action = runtime.runChildSession(request);

        // Then
        await expectNonRetryableTaskRejection(action);
        expect(contexts).toEqual([]);
        expect(services.runtimeRegistry.lookup(request.sessionId)).toBeUndefined();
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

    it('does not inherit the CLI root marker into nested runtimes', async () => {
        const services = makeTaskRuntimeServices();
        const agentIndex = new AgentIndex();
        agentIndex.register(makePermissionAgent({ name: 'mid-agent', spawns: '*' }));
        agentIndex.register(makePermissionAgent({ name: 'leaf-agent', spawns: '*' }));
        agentIndex.register(makePermissionAgent({ name: 'terminal-agent', spawns: '*' }));

        const parentToolRegistry = new ToolRegistry();
        parentToolRegistry.register(makePermissionTool('repo.read', ['repo.read'], { value: 0 }));
        parentToolRegistry.register(makePermissionTool('task', ['subagent'], { value: 0 }));

        const spawnChain: { sessionId: string; hasTask: boolean; agentName: string }[] = [];
        let midChildToolRegistry: ToolRegistry | undefined;
        let leafChildToolRegistry: ToolRegistry | undefined;
        const rootRuntime = new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel: () => ({ providerID: 'test', modelID: 'model' }),
            workspaceRoot: '/tmp/workspace',
            parentToolRegistry,
            parentAgent: makePermissionAgent({ name: 'root-agent', spawns: '*' }),
            parentSessionId: 'durable-cli-root',
            isCliRootParent: true,
            services,
            spawnFn: async (context) => {
                spawnChain.push({
                    sessionId: context.sessionId,
                    hasTask: context.childToolRegistry.advertise().some((t) => t.name === 'task'),
                    agentName: context.agent.name,
                });
                if (context.agent.name === 'mid-agent') midChildToolRegistry = context.childToolRegistry;
                if (context.agent.name === 'leaf-agent') leafChildToolRegistry = context.childToolRegistry;
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
        expect(services.runtimeRegistry.lookup('mid-session')?.parentId).toBe('durable-cli-root');

        if (midChildToolRegistry === undefined) throw new Error('mid child tool registry was not captured');
        await invokeNestedTask(midChildToolRegistry, 'mid-task', 'leaf-agent');
        if (leafChildToolRegistry === undefined) throw new Error('leaf child tool registry was not captured');
        await invokeNestedTask(leafChildToolRegistry, 'leaf-task', 'terminal-agent');

        expect(spawnChain[1]?.agentName).toBe('leaf-agent');
        expect(spawnChain[1]?.hasTask).toBe(true);
        const leafSessionId = spawnChain[1]?.sessionId;
        if (leafSessionId === undefined) throw new Error('leaf child session was not captured');
        expect(services.runtimeRegistry.lookup(leafSessionId)?.taskDepth).toBe(2);
        expect(services.runtimeRegistry.lookup(leafSessionId)?.parentId).toBe('mid-session');
        expect(spawnChain[2]?.agentName).toBe('terminal-agent');
        expect(spawnChain[2]?.hasTask).toBe(false);
        const terminalSessionId = spawnChain[2]?.sessionId;
        if (terminalSessionId === undefined) throw new Error('terminal child session was not captured');
        expect(services.runtimeRegistry.lookup(terminalSessionId)?.taskDepth).toBe(3);
        expect(services.runtimeRegistry.lookup(terminalSessionId)?.parentId).toBe(leafSessionId);
    });
});
