import { describe, expect, it } from 'vitest';
import { createActionGraph } from './action-graph.js';
import { createAuthorableAbgGraph, resolveAbgNodeModel } from './authorable-graph.js';
import { AbgGraphValidationError, compileAbgRule } from './rule-compiler.js';

describe('ActionGraph', () => {
    it('keeps createActionGraph compatibility baseline before authorable ABG graph support', () => {
        const original = {
            id: 'graph_baseline',
            nodes: [
                {
                    id: 'start',
                    type: 'sequence',
                },
            ],
            edges: [],
        } as const;

        const graph = createActionGraph(original);

        expect(graph).toEqual(original);
        expect(graph).not.toBe(original);
        expect(graph.nodes).not.toBe(original.nodes);
    });

    it('validates node and edge shape', () => {
        const graph = createActionGraph({
            id: 'graph_demo',
            nodes: [
                {
                    id: 'start',
                    type: 'sequence',
                },
                {
                    id: 'act',
                    type: 'action',
                },
            ],
            edges: [
                {
                    from: 'start',
                    to: 'act',
                },
            ],
        });

        expect(graph.nodes.map((node) => node.id)).toEqual(['start', 'act']);
        expect(() =>
            createActionGraph({
                id: 'graph_bad',
                nodes: [{ id: 'start', type: 'sequence' }],
                edges: [{ from: 'start', to: 'missing' }],
            }),
        ).toThrow('unknown action graph edge target');
    });

    it('compiles declarative rules for authorable ABG graphs', () => {
        const graph = createAuthorableAbgGraph({
            id: 'authorable-research',
            entryNodeId: 'classify-intent',
            defaults: {
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                    variantID: 'default',
                },
            },
            nodes: [
                {
                    id: 'classify-intent',
                    kind: 'llm',
                },
                {
                    id: 'gather-context',
                    kind: 'parallel',
                    rules: ['classification-succeeded'],
                },
            ],
            edges: [
                {
                    source: 'classify-intent',
                    target: 'gather-context',
                    condition: 'classification-succeeded',
                    priority: 10,
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
        });
        const rule = graph.compiledRules[0];

        expect(graph.nodes.map((node) => node.id)).toEqual(['classify-intent', 'gather-context']);
        expect(rule?.matches({ signalType: 'success' })).toBe(true);
        expect(rule?.matches({ signalType: 'failure' })).toBe(false);
        expect(resolveAbgNodeModel(graph, 'gather-context')).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
            variantID: 'default',
        });
    });

    it('creates immutable authorable ABG graphs from caller-owned specs', () => {
        const spec = {
            id: 'copy-test',
            entryNodeId: 'start',
            nodes: [
                {
                    id: 'start',
                    kind: 'condition',
                },
            ],
            edges: [],
            rules: [],
        };

        const graph = createAuthorableAbgGraph(spec);
        spec.nodes[0] = {
            id: 'mutated',
            kind: 'action',
        };

        expect(graph.nodes[0]?.id).toBe('start');
        expect(Object.isFrozen(graph.nodes[0])).toBe(true);
        expect(Object.isFrozen(graph.edges)).toBe(true);
    });

    it('rejects arbitrary rule expressions', () => {
        expect(() =>
            compileAbgRule({
                id: 'unsafe-expression',
                when: {
                    kind: 'javascript.expression',
                    expression: 'process.exit(1)',
                },
            }),
        ).toThrow('unsupported ABG rule predicate');
    });

    it('throws typed authorable ABG graph validation errors', () => {
        expect(() =>
            createAuthorableAbgGraph({
                id: 'bad-rules',
                entryNodeId: 'start',
                nodes: [
                    {
                        id: 'start',
                        kind: 'condition',
                        rules: ['missing-rule'],
                    },
                ],
                edges: [],
                rules: [],
            }),
        ).toThrow(AbgGraphValidationError);
        expect(() =>
            createAuthorableAbgGraph({
                id: 'bad-edge-rule',
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
            }),
        ).toThrow(AbgGraphValidationError);
    });
});
