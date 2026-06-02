import { describe, expect, it } from 'vitest';
import { createActionGraph } from './action-graph.js';

describe('ActionGraph', () => {
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
});
