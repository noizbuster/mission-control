import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from './agent-runtime.js';

describe('AgentRuntime', () => {
    it('runDemoTask emits start/progress/completed events and snapshot', async () => {
        const runtime = new AgentRuntime({ useNative: false, permissionDecisionResolver: allowAllPermissions });
        const events: string[] = [];
        const unsubscribe = runtime.onEvent((event) => {
            events.push(event.type);
        });

        const session = await runtime.start();
        await runtime.runDemoTask();
        const snapshot = runtime.getSnapshot();
        unsubscribe();

        expect(session.id).toMatch(/^session_/);
        expect(events).toContain('session.started');
        expect(events).toContain('task.started');
        expect(events).toContain('task.progress');
        expect(events).toContain('task.completed');
        expect(snapshot.status).toBe('running');
        expect(snapshot.completedTaskCount).toBe(1);
        expect(snapshot.lastMessage).toBe('completed by mock sidecar');
    });

    it('emits selected provider and model on session and task events', async () => {
        const runtime = new AgentRuntime({
            useNative: false,
            permissionDecisionResolver: allowAllPermissions,
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        const events: AgentEvent[] = [];
        const unsubscribe = runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await runtime.runDemoTask();
        unsubscribe();

        expect(events.map((event) => event.modelProviderSelection)).toEqual(
            events.map(() => ({
                providerID: 'local',
                modelID: 'local-echo',
            })),
        );
    });

    it('uses the default model provider selection when none is configured', async () => {
        const runtime = new AgentRuntime({ useNative: false, permissionDecisionResolver: allowAllPermissions });
        const events: AgentEvent[] = [];
        const unsubscribe = runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await runtime.runDemoTask();
        const snapshot = runtime.getSnapshot();
        unsubscribe();

        expect(events[0]?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(snapshot.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('emits scaffold skill invocation events', async () => {
        const runtime = new AgentRuntime({ useNative: false, permissionDecisionResolver: allowAllPermissions });

        await runtime.start();
        runtime.setModelProviderSelection({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
        });
        const response = await runtime.runSkillInvocationTask({
            skillID: 'omo:ulw-plan',
            argumentsText: 'plan auth',
        });
        const events = runtime.getEvents();

        expect(response).toBe('skill invocation scaffolded: omo:ulw-plan');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'permission.requested',
                message: 'permission requested: skill.invoke',
                modelProviderSelection: {
                    providerID: 'anthropic',
                    modelID: 'claude-3-5-haiku-20241022',
                },
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'task.started',
                message: 'skill invocation started: omo:ulw-plan',
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'task.completed',
                message: 'skill invocation scaffolded: omo:ulw-plan',
            }),
        );
    });

    it('blocks default-denied demo effects before task execution', async () => {
        const runtime = new AgentRuntime({ useNative: false });
        const events: AgentEvent[] = [];
        const unsubscribe = runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await expect(runtime.runDemoTask()).rejects.toMatchObject({ code: 'permission_denied' });
        unsubscribe();

        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['permission.requested', 'approval.blocked']),
        );
        expect(events.some((event) => event.type === 'task.started')).toBe(false);
        expect(runtime.getSnapshot().completedTaskCount).toBe(0);
    });

    it('does not call a fake effect callback under default deny', async () => {
        const runtime = new AgentRuntime({ useNative: false });
        let effectCalls = 0;

        await runtime.start();
        await expect(
            runPermissionedFakeEffect(runtime, () => {
                effectCalls += 1;
            }),
        ).rejects.toMatchObject({ code: 'permission_denied' });

        expect(effectCalls).toBe(0);
        expect(runtime.getEvents().map((event) => event.type)).toEqual(
            expect.arrayContaining(['permission.requested', 'approval.blocked']),
        );
    });
});

async function runPermissionedFakeEffect(runtime: AgentRuntime, effect: () => void): Promise<void> {
    await runtime.requestPermission({
        id: 'permission_fake_effect',
        action: 'fake.effect',
        reason: 'fake effect permission gate',
    });
    effect();
}

function allowAllPermissions(request: PermissionRequest): PermissionDecision {
    return {
        requestId: request.id,
        status: 'allow',
        reason: 'test allow',
    };
}
