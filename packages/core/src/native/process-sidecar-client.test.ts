import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../agent-runtime.js';

describe('ProcessSidecarClient fallback', () => {
    it('falls back to mock and emits native.warning when spawn fails', async () => {
        const runtime = new AgentRuntime({
            useNative: true,
            sidecarCommand: '/missing/mission-control-sidecar',
        });
        const events: string[] = [];
        runtime.onEvent((event) => {
            events.push(event.type);
        });

        await runtime.start();
        await runtime.runDemoTask();
        const snapshot = runtime.getSnapshot();

        expect(events).toContain('native.warning');
        expect(events).toContain('task.completed');
        expect(snapshot.lastMessage).toBe('completed by mock sidecar');
        expect(snapshot.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });
});
