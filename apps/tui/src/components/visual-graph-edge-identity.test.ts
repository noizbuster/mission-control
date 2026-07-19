import { describe, expect, it } from 'vitest';
import { renderVisualGraph, type VisualGraphNode } from './visual-graph';

function node(nodeId: string): VisualGraphNode {
    return { nodeId, status: 'idle', isActive: false };
}

describe('visual-graph edge identity', () => {
    it('keeps delimiter-colliding endpoint pairs and their labels distinct', () => {
        const firstSource = 'a\u0001b';
        const firstTarget = 'c';
        const secondSource = 'a';
        const secondTarget = 'b\u0001c';

        const graph = renderVisualGraph({
            nodes: [node(firstSource), node(firstTarget), node(secondSource), node(secondTarget)],
            edges: [
                { from: firstSource, to: firstTarget, label: 'label-1' },
                { from: secondSource, to: secondTarget, label: 'label-2' },
            ],
            maxWidth: 100,
        });

        expect(graph.lines.join('\n')).toContain('label-1');
        expect(graph.lines.join('\n')).toContain('label-2');
    });
});
