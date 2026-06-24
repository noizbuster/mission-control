import { describe, expect, it } from 'vitest';
import {
    renderVisualGraph,
    statusColor,
    statusGlyph,
    VISUAL_GRAPH_MAX_NODES,
    type VisualGraphEdge,
    type VisualGraphNode,
} from './visual-graph.js';

function node(nodeId: string, status: VisualGraphNode['status'], isActive = false): VisualGraphNode {
    return { nodeId, status, isActive };
}

describe('visual-graph renderVisualGraph', () => {
    it('returns collapsed=true when node count exceeds maxNodes', () => {
        const nodes = Array.from({ length: VISUAL_GRAPH_MAX_NODES + 1 }, (_, i) => node(`n${i}`, 'idle' as const));
        const result = renderVisualGraph({ nodes, edges: [] });
        expect(result.collapsed).toBe(true);
        expect(result.lines).toEqual([]);
    });

    it('returns placeholder when nodes empty', () => {
        const result = renderVisualGraph({ nodes: [], edges: [] });
        expect(result.collapsed).toBe(false);
        expect(result.lines).toEqual(['(no nodes)']);
    });

    it('renders each node on its own line with status glyph', () => {
        const nodes = [node('start', 'succeeded'), node('middle', 'running', true), node('end', 'idle')];
        const result = renderVisualGraph({ nodes, edges: [] });
        expect(result.collapsed).toBe(false);
        expect(result.lines[0]).toContain('✓');
        expect(result.lines[0]).toContain('start');
        expect(result.lines[1]).toContain('▶');
        expect(result.lines[1]).toContain('middle');
        expect(result.lines[1]).toContain('*');
    });

    it('draws a vertical connector between two nodes with a single edge', () => {
        const nodes = [node('a', 'succeeded'), node('b', 'running')];
        const edges: VisualGraphEdge[] = [{ from: 'a', to: 'b' }];
        const result = renderVisualGraph({ nodes, edges });
        expect(result.lines).toContain('│');
        expect(result.lines).toContain('▼');
    });

    it('includes the edge label on the connector line', () => {
        const nodes = [node('a', 'succeeded'), node('b', 'running')];
        const edges: VisualGraphEdge[] = [{ from: 'a', to: 'b', label: 'success' }];
        const result = renderVisualGraph({ nodes, edges });
        const connectorLine = result.lines.find((line) => line.includes('success'));
        expect(connectorLine).toBeDefined();
    });

    it('renders a fan-out branch for multi-edges', () => {
        const nodes = [node('parent', 'succeeded'), node('child1', 'running'), node('child2', 'idle')];
        const edges: VisualGraphEdge[] = [
            { from: 'parent', to: 'child1' },
            { from: 'parent', to: 'child2' },
        ];
        const result = renderVisualGraph({ nodes, edges });
        expect(result.lines.some((line) => line.startsWith('├──►'))).toBe(true);
        expect(result.lines.some((line) => line.startsWith('└──►'))).toBe(true);
    });

    it('truncates long node ids to fit the configured width', () => {
        const longId = 'a'.repeat(50);
        const nodes = [node(longId, 'idle')];
        const result = renderVisualGraph({ nodes, edges: [], maxWidth: 20 });
        expect(result.lines[0]?.length).toBeLessThan(longId.length + 5);
        expect(result.lines[0]).toContain('…');
    });

    it('emits structured node rows with bracketed status and per-segment status tinting', () => {
        const nodes = [node('start', 'succeeded'), node('work', 'running', true)];
        const result = renderVisualGraph({ nodes, edges: [] });
        const nodeRows = result.rows.filter((row) => row.kind === 'node');
        expect(nodeRows).toHaveLength(2);

        const first = nodeRows[0];
        expect(first?.status).toBe('succeeded');
        expect(first?.isActive).toBe(false);
        expect(first?.segments.map((s) => s.text).join('')).toBe('✓ start [succeeded]');
        expect(first?.segments[0]).toMatchObject({ text: '✓', status: 'succeeded' });
        expect(first?.segments.some((s) => s.text === 'succeeded' && s.status === 'succeeded')).toBe(true);

        const second = nodeRows[1];
        expect(second?.isActive).toBe(true);
        // The active marker lives only in the flat `lines` view; the React consumer renders an
        // animated spinner off `isActive` instead of a static `*`.
        expect(second?.segments.map((s) => s.text).join('')).toBe('▶ work [running]');
        expect(result.lines[result.lines.length - 1]).toBe('▶ work [running] *');
    });
});

describe('visual-graph status helpers', () => {
    it('returns a glyph for every known status', () => {
        expect(statusGlyph('running')).toBe('▶');
        expect(statusGlyph('succeeded')).toBe('✓');
        expect(statusGlyph('failed')).toBe('✗');
        expect(statusGlyph('blocked')).toBe('⏸');
        expect(statusGlyph('cancelled')).toBe('⊘');
        expect(statusGlyph('idle')).toBe('∙');
    });

    it('returns a color string for every known status', () => {
        expect(statusColor('running')).toBe('yellow');
        expect(statusColor('succeeded')).toBe('green');
        expect(statusColor('failed')).toBe('red');
    });
});
