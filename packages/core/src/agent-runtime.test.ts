import type { AbgGraphSpec, AgentEvent } from '@mission-control/protocol';
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
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(snapshot.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('uses a session-local active model selection', async () => {
        const runtime = new AgentRuntime({ useNative: false });
        const otherRuntime = new AgentRuntime({ useNative: false });

        await runtime.start();
        runtime.setModelProviderSelection({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
        });
        await runtime.runPromptTask('explain model routing');
        await otherRuntime.start();
        await otherRuntime.runPromptTask('default model routing');
        const completed = runtime
            .getEvents()
            .find(
                (event) =>
                    event.type === 'task.completed' && event.message === 'received prompt: explain model routing',
            );
        const otherCompleted = otherRuntime
            .getEvents()
            .find(
                (event) =>
                    event.type === 'task.completed' && event.message === 'received prompt: default model routing',
            );

        expect(completed?.modelProviderSelection).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
        });
        expect(otherCompleted?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('emits scaffold skill invocation events', async () => {
        const runtime = new AgentRuntime({ useNative: false });

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

    it('runGraph emits graph and node lifecycle events', async () => {
        const runtime = new AgentRuntime({
            useNative: false,
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        const graph = createRuntimeGraph();

        await runtime.start();
        const result = await runtime.runGraph(graph, {
            input: {
                question: 'What changed?',
            },
        });
        const events = runtime.getEvents();
        const eventTypes = events.map((event) => event.type);
        const llmCompleted = events.find(
            (event) => event.type === 'node.completed' && event.abg?.nodeId === 'draft-answer',
        );

        expect(result.status).toBe('completed');
        expect(eventTypes).toEqual(
            expect.arrayContaining([
                'graph.started',
                'node.started',
                'decision.selected',
                'node.completed',
                'graph.completed',
            ]),
        );
        expect(llmCompleted?.abg?.model).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
            variantID: 'default',
        });
        expect(events.at(-1)).toMatchObject({
            type: 'graph.completed',
            abg: {
                graphId: 'runtime-research',
            },
        });
    });

    it('runGraph rejects malformed graph before graph events are emitted', async () => {
        const runtime = new AgentRuntime({ useNative: false });

        await runtime.start();
        await expect(
            runtime.runGraph({
                id: 'bad-runtime-graph',
                entryNodeId: 'missing',
                nodes: [
                    {
                        id: 'start',
                        kind: 'action',
                    },
                ],
            }),
        ).rejects.toThrow('invalid ABG graph spec');

        expect(runtime.getEvents().filter((event) => event.type.startsWith('graph.'))).toEqual([]);
    });

    it('runGraph blocks destructive tool by policy', async () => {
        const runtime = new AgentRuntime({ useNative: false });
        const graph: AbgGraphSpec = {
            id: 'policy-blocked-runtime',
            entryNodeId: 'delete-files',
            nodes: [
                {
                    id: 'delete-files',
                    kind: 'tool',
                    capabilities: ['filesystem.write'],
                },
            ],
            edges: [],
            rules: [],
            policies: [
                {
                    id: 'deny-write',
                    capability: 'filesystem.write',
                    decision: 'deny',
                    reason: 'filesystem writes are disabled',
                },
            ],
        };

        await runtime.start();
        const result = await runtime.runGraph(graph);
        const events = runtime.getEvents();

        expect(result.status).toBe('blocked');
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['permission.requested', 'policy.blocked', 'graph.failed']),
        );
        expect(events.find((event) => event.type === 'permission.requested')?.permissionDecision).toEqual({
            requestId: 'permission_policy-blocked-runtime_delete-files',
            status: 'deny',
            reason: 'filesystem writes are disabled',
        });
    });

    it('runGraph exposes graph snapshot and timeline from emitted events', async () => {
        const runtime = new AgentRuntime({ useNative: false });

        await runtime.start();
        await runtime.runGraph(createRuntimeGraph());

        expect(runtime.getGraphSnapshot('runtime-research')).toMatchObject({
            graphId: 'runtime-research',
            status: 'completed',
        });
        expect(runtime.getTimeline().map((entry) => entry.type)).toEqual(
            expect.arrayContaining(['graph.started', 'node.completed', 'decision.selected', 'graph.completed']),
        );
    });
});

function createRuntimeGraph(): AbgGraphSpec {
    return {
        id: 'runtime-research',
        entryNodeId: 'draft-answer',
        defaults: {
            model: {
                providerID: 'local',
                modelID: 'local-echo',
                variantID: 'default',
            },
        },
        nodes: [
            {
                id: 'draft-answer',
                kind: 'llm',
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                    variantID: 'default',
                },
            },
            {
                id: 'finish',
                kind: 'action',
            },
        ],
        edges: [
            {
                source: 'draft-answer',
                target: 'finish',
                condition: 'draft-succeeded',
                priority: 10,
            },
        ],
        rules: [
            {
                id: 'draft-succeeded',
                when: {
                    kind: 'signal.type.equals',
                    signalType: 'success',
                },
                activate: 'finish',
            },
        ],
        policies: [],
    };
}
