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
        expect(inkOutput).toContain('provider: local');
        expect(inkOutput).toContain('model: local-echo');
        expect(inkOutput).toContain('selection: local/local-echo');
        expect(inkOutput).toContain('node mode: none');
        expect(plainOutput).toContain('provider: local');
        expect(plainOutput).toContain('model: local-echo');
        expect(plainOutput).toContain('selection: local/local-echo');
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

    it('plain renderer prints graph node mode when graph node context exists', async () => {
        const renderer = new PlainRenderer();

        renderer.render({
            type: 'node.started',
            timestamp: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_graph',
            message: 'node started: draft-answer',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
            abg: {
                graphId: 'research-answer',
                nodeId: 'draft-answer',
                nodeKind: 'llm',
            },
        });

        expect(renderer.getOutput()).toContain('node.started graph=research-answer node=draft-answer mode=llm');
    });

    it('json renderer includes machine-readable run state metadata', async () => {
        const renderer = new JsonRenderer();

        renderer.render({
            type: 'run.started',
            timestamp: '2026-06-13T00:00:00.000Z',
            sessionId: 'session_json_machine',
            message: 'run started',
            run: {
                command: 'run',
                state: 'running',
                runId: 'run_json_machine',
            },
        });
        renderer.render({
            type: 'run.completed',
            timestamp: '2026-06-13T00:00:01.000Z',
            sessionId: 'session_json_machine',
            message: 'run completed',
            run: {
                command: 'run',
                state: 'completed',
                runId: 'run_json_machine',
            },
        });
        renderer.render({
            type: 'session.stopped',
            timestamp: '2026-06-13T00:00:02.000Z',
            sessionId: 'session_json_machine',
            message: 'mission-control session stopped',
            nativeSidecarStatus: 'mock',
        });

        const records = renderer
            .getOutput()
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const finalRecord = records.at(-1);

        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            sessionId: 'session_json_machine',
            status: 'completed',
            runId: 'run_json_machine',
            machine: {
                session: {
                    sessionId: 'session_json_machine',
                },
                run: {
                    runId: 'run_json_machine',
                    status: 'completed',
                },
            },
        });
    });
});
