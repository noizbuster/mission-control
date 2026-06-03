import { AgentRuntime } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { type AgentUIRenderer, InkRenderer, JsonRenderer, PlainRenderer } from './renderers.js';

const event: AgentEvent = {
    type: 'task.completed',
    timestamp: '2026-06-02T10:00:00.000Z',
    sessionId: 'session_test',
    taskId: 'task_1',
    message: 'completed by mock sidecar',
    nativeSidecarStatus: 'mock',
    modelProviderSelection: {
        providerID: 'local',
        modelID: 'local-echo',
    },
};

async function renderWith(renderer: AgentUIRenderer): Promise<string> {
    await renderer.start(new AgentRuntime({ useNative: false }));
    renderer.render(event);
    await renderer.stop();
    return renderer.getOutput();
}

describe('CLI renderers', () => {
    it('ink plain and json renderers implement AgentUIRenderer', async () => {
        const inkOutput = await renderWith(new InkRenderer());
        const plainOutput = await renderWith(new PlainRenderer());
        const jsonOutput = await renderWith(new JsonRenderer());

        expect(inkOutput).toContain('event list');
        expect(inkOutput).toContain('model: local/local-echo');
        expect(plainOutput).toContain('model: local/local-echo');
        expect(plainOutput).toContain('task.completed completed by mock sidecar');
        expect(JSON.parse(jsonOutput.trim())).toMatchObject({
            type: 'task.completed',
            taskId: 'task_1',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
    });
});
