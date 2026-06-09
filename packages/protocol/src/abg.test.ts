import { describe, expect, it } from 'vitest';
import { AbgGraphSnapshotSchema, AbgGraphSpecSchema, AbgNodeModelOptionsSchema, AbgSignalSchema } from './abg.js';
import { AgentEventSchema } from './schema.js';

describe('ABG protocol schemas', () => {
    it('parses ABG protocol graph specs with node model variants', () => {
        const graph = AbgGraphSpecSchema.parse({
            id: 'research-answer',
            version: '1',
            entryNodeId: 'classify-intent',
            defaults: {
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                    variantID: 'default',
                    role: 'planner',
                    temperature: 0.2,
                    maxOutputTokens: 1024,
                    timeoutMs: 5000,
                    budgetCents: 5,
                    fallbacks: [
                        {
                            providerID: 'local',
                            modelID: 'local-echo',
                            variantID: 'default',
                        },
                    ],
                },
            },
            nodes: [
                {
                    id: 'classify-intent',
                    kind: 'llm',
                    label: 'Classify intent',
                    model: {
                        providerID: 'local',
                        modelID: 'local-echo',
                        variantID: 'default',
                        role: 'classifier',
                    },
                },
                {
                    id: 'gather-context',
                    kind: 'parallel',
                    label: 'Gather context',
                    children: ['memory-search', 'mock-search'],
                },
                {
                    id: 'memory-search',
                    kind: 'memory',
                },
                {
                    id: 'mock-search',
                    kind: 'tool',
                    capabilities: ['network.read'],
                },
            ],
            edges: [
                {
                    id: 'classification-success',
                    source: 'classify-intent',
                    target: 'gather-context',
                    condition: 'classification-succeeded',
                    priority: 10,
                    mapping: {
                        intent: 'blackboard.intent',
                    },
                },
            ],
            rules: [
                {
                    id: 'classification-succeeded',
                    when: {
                        kind: 'signal.type.equals',
                        signalType: 'success',
                    },
                    activate: 'gather-context',
                },
            ],
            policies: [
                {
                    id: 'safe-tooling',
                    capability: 'network.read',
                    decision: 'allow',
                },
            ],
        });

        expect(graph.nodes.map((node) => node.kind)).toEqual(['llm', 'parallel', 'memory', 'tool']);
        expect(graph.nodes[0]?.model).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
            variantID: 'default',
            role: 'classifier',
        });
        expect(graph.edges[0]?.priority).toBe(10);
        expect(graph.rules[0]?.when.kind).toBe('signal.type.equals');
    });

    it('rejects malformed ABG protocol graph specs', () => {
        const duplicateNodes = AbgGraphSpecSchema.safeParse({
            id: 'bad-graph',
            entryNodeId: 'start',
            nodes: [
                {
                    id: 'start',
                    kind: 'sequence',
                },
                {
                    id: 'start',
                    kind: 'action',
                },
            ],
            edges: [],
        });
        const unknownEdge = AbgGraphSpecSchema.safeParse({
            id: 'bad-edge',
            entryNodeId: 'start',
            nodes: [
                {
                    id: 'start',
                    kind: 'sequence',
                },
            ],
            edges: [
                {
                    source: 'start',
                    target: 'missing',
                },
            ],
        });
        const emptyRule = AbgGraphSpecSchema.safeParse({
            id: 'bad-rule',
            entryNodeId: 'start',
            nodes: [
                {
                    id: 'start',
                    kind: 'condition',
                },
            ],
            edges: [],
            rules: [
                {
                    id: '',
                    when: {
                        kind: 'event.type.equals',
                        eventType: 'user.message.received',
                    },
                },
            ],
        });
        const unknownEdgeCondition = AbgGraphSpecSchema.safeParse({
            id: 'bad-edge-condition',
            entryNodeId: 'start',
            nodes: [
                {
                    id: 'start',
                    kind: 'condition',
                },
                {
                    id: 'next',
                    kind: 'action',
                },
            ],
            edges: [
                {
                    source: 'start',
                    target: 'next',
                    condition: 'missing-rule',
                },
            ],
            rules: [],
        });
        const invalidModelOptions = AbgNodeModelOptionsSchema.safeParse({
            providerID: 'local',
            modelID: 'local-echo',
            temperature: 3,
        });

        expect(duplicateNodes.success).toBe(false);
        expect(unknownEdge.success).toBe(false);
        expect(unknownEdgeCondition.success).toBe(false);
        expect(emptyRule.success).toBe(false);
        expect(invalidModelOptions.success).toBe(false);
    });

    it('parses ABG protocol signals, snapshots, and graph event metadata', () => {
        const signal = AbgSignalSchema.parse({
            type: 'transition',
            graphId: 'research-answer',
            nodeId: 'workflow',
            from: 'planning',
            to: 'executing',
        });
        const snapshot = AbgGraphSnapshotSchema.parse({
            graphId: 'research-answer',
            status: 'active',
            activeNodeIds: ['workflow'],
            nodes: [
                {
                    nodeId: 'workflow',
                    status: 'running',
                },
            ],
        });
        const event = AgentEventSchema.parse({
            type: 'node.completed',
            timestamp: '2026-06-03T10:00:00.000Z',
            sessionId: 'session_abg',
            taskId: 'graph_research-answer',
            message: 'node completed: classify-intent',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
            abg: {
                graphId: 'research-answer',
                nodeId: 'classify-intent',
                signalType: 'success',
                causationId: 'event_1',
                correlationId: 'run_1',
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                    variantID: 'default',
                    role: 'classifier',
                },
            },
        });

        expect(signal.type).toBe('transition');
        expect(snapshot.nodes[0]?.status).toBe('running');
        expect(event.abg?.model?.variantID).toBe('default');
    });
});
