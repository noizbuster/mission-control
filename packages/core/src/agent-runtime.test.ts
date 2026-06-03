import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from './agent-runtime.js';

describe('AgentRuntime', () => {
    it('runDemoTask emits start/progress/completed events and snapshot', async () => {
        const runtime = new AgentRuntime({ useNative: false });
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
        const runtime = new AgentRuntime({ useNative: false });
        const events: AgentEvent[] = [];
        const unsubscribe = runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await runtime.runDemoTask();
        const snapshot = runtime.getSnapshot();
        unsubscribe();

        expect(events[0]?.modelProviderSelection).toEqual({
            providerID: 'mock',
            modelID: 'mission-control-demo',
        });
        expect(snapshot.modelProviderSelection).toEqual({
            providerID: 'mock',
            modelID: 'mission-control-demo',
        });
    });
});
