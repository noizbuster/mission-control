import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../agent-runtime.js';
import { createAllowPermissionDecision } from '../permissions.js';

describe('ProcessSidecarClient fallback', () => {
    it('falls back to mock and emits native.warning when spawn fails', async () => {
        const runtime = new AgentRuntime({
            useNative: true,
            sidecarCommand: '/missing/mission-control-sidecar',
            permissionDecisionResolver: createAllowPermissionDecision,
        });
        const events: AgentEvent[] = [];
        runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await runtime.runDemoTask();
        const snapshot = runtime.getSnapshot();

        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['native.warning', 'task.completed']));
        expect(events.find((event) => event.type === 'session.started')?.nativeSidecarStatus).toBe('unknown');
        expect(events.find((event) => event.type === 'native.warning')?.nativeSidecarStatus).toBe('unavailable');
        expect(events.at(-1)?.nativeSidecarStatus).toBe('mock');
        expect(snapshot.lastMessage).toBe('completed by mock sidecar');
        expect(snapshot.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });
});
