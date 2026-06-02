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
});
