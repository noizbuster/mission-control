import { describe, expect, it } from 'vitest';
import {
    renderVisualGraph,
    VISUAL_GRAPH_DEFAULT_WIDTH,
    VISUAL_GRAPH_MAX_NODES,
    type VisualGraphEdge,
    type VisualGraphNode,
    visualGraphBoundsForViewport,
} from './visual-graph';

const AbgNodeStatusValues = ['idle', 'starting', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'] as const;

function node(nodeId: string, status: VisualGraphNode['status'], isActive = false): VisualGraphNode {
    return { nodeId, status, isActive };
}

function joinedLines(result: { readonly lines: readonly string[] }): string {
    return result.lines.join('\n');
}

const WIDE = 100;

describe('visual-graph renderVisualGraph', () => {
    describe('edge cases', () => {
        it('returns placeholder when nodes empty', () => {
            const result = renderVisualGraph({ nodes: [], edges: [], maxWidth: WIDE });
            expect(result.collapsed).toBe(false);
            expect(result.lines).toEqual(['(no nodes)']);
        });

        it('returns collapsed summary when node count exceeds maxNodes', () => {
            const nodes = Array.from({ length: VISUAL_GRAPH_MAX_NODES + 1 }, (_, i) => node(`n${i}`, 'idle'));
            const result = renderVisualGraph({ nodes, edges: [], maxWidth: WIDE });
            expect(result.collapsed).toBe(true);
            expect(joinedLines(result)).toContain('too large');
            expect(joinedLines(result)).toContain(`${VISUAL_GRAPH_MAX_NODES + 1} nodes`);
        });

        it('summary reports the status distribution', () => {
            const nodes = [
                ...Array.from({ length: VISUAL_GRAPH_MAX_NODES + 1 }, () => node('x', 'running')),
                ...Array.from({ length: 3 }, (_, i) => node(`y${i}`, 'succeeded')),
            ];
            const result = renderVisualGraph({ nodes, edges: [], maxWidth: WIDE });
            expect(result.collapsed).toBe(true);
            expect(joinedLines(result)).toContain('running');
            expect(joinedLines(result)).toContain('succeeded');
        });

        it('pans horizontally with offsetX so right-side nodes become visible', () => {
            const nodes = Array.from({ length: 6 }, (_, i) => node(`wide${i}`, 'idle'));
            const edges = [
                { from: 'wide0', to: 'wide1' },
                { from: 'wide0', to: 'wide2' },
                { from: 'wide0', to: 'wide3' },
                { from: 'wide0', to: 'wide4' },
                { from: 'wide0', to: 'wide5' },
            ];
            const full = renderVisualGraph({ nodes, edges, maxWidth: 200 });
            expect(full.fullWidth).toBeGreaterThan(30);
            const panned = renderVisualGraph({
                nodes,
                edges,
                maxWidth: 30,
                offsetX: Math.max(0, full.fullWidth - 30),
            });
            expect(panned.collapsed).toBe(false);
            expect(panned.offsetX).toBeGreaterThan(0);
            expect(panned.pannable).toBe(true);
            expect(panned.width).toBeLessThanOrEqual(30);
        });

        it('pans vertically with offsetY and maxHeight', () => {
            const nodes = Array.from({ length: 8 }, (_, i) => node(`tall${i}`, 'idle'));
            const edges = Array.from({ length: 7 }, (_, i) => ({ from: `tall${i}`, to: `tall${i + 1}` }));
            const full = renderVisualGraph({ nodes, edges, maxWidth: WIDE });
            expect(full.fullHeight).toBeGreaterThan(4);
            const panned = renderVisualGraph({
                nodes,
                edges,
                maxWidth: WIDE,
                maxHeight: 4,
                offsetY: 3,
            });
            expect(panned.rows.length).toBeLessThanOrEqual(4);
            expect(panned.offsetY).toBeGreaterThan(0);
            expect(panned.pannable).toBe(true);
        });
    });

    describe('simple chain (A->B->C)', () => {
        const result = renderVisualGraph({
            nodes: [node('start', 'succeeded'), node('work', 'running', true), node('end', 'idle')],
            edges: [
                { from: 'start', to: 'work' },
                { from: 'work', to: 'end' },
            ],
            maxWidth: WIDE,
        });

        it('renders every node id', () => {
            const text = joinedLines(result);
            expect(text).toContain('start');
            expect(text).toContain('work');
            expect(text).toContain('end');
        });

        it('renders status glyphs from the centralized theme', () => {
            const text = joinedLines(result);
            expect(text).toContain('\u2713'); // succeeded
            expect(text).toContain('\u25b6'); // running
            expect(text).toContain('\u2219'); // idle
        });

        it('draws a vertical connector and down arrowhead between ranks', () => {
            const text = joinedLines(result);
            expect(text).toContain('\u2502'); // vertical stem
            expect(text).toContain('\u25bc'); // down arrowhead
        });

        it('emits structured node rows with per-segment status tinting', () => {
            const nodeRows = result.rows.filter((row) => row.kind === 'node');
            expect(nodeRows.length).toBeGreaterThanOrEqual(3);
            const succeededSegments = result.rows
                .filter((row) => row.status === 'succeeded')
                .flatMap((row) => row.segments);
            const tinted = succeededSegments.find(
                (segment) => segment.status === 'succeeded' && segment.text.includes('\u2713'),
            );
            expect(tinted).toBeDefined();
        });

        it('flags the active node row', () => {
            const activeRows = result.rows.filter((row) => row.isActive === true);
            expect(activeRows.length).toBeGreaterThan(0);
        });
    });

    describe('edge label', () => {
        it('renders the edge label text on the connector', () => {
            const result = renderVisualGraph({
                nodes: [node('a', 'succeeded'), node('b', 'running')],
                edges: [{ from: 'a', to: 'b', label: 'success' }],
                maxWidth: WIDE,
            });
            expect(joinedLines(result)).toContain('success');
        });
    });

    describe('viewport-derived graph pane bounds', () => {
        it('keeps a 40x10 viewport finite, positive, and non-negative', () => {
            const bounds = visualGraphBoundsForViewport({ columns: 40, rows: 10 });

            expect(bounds).toEqual({ maxWidth: 34, maxHeight: 8 });
            expect(Number.isFinite(bounds.maxWidth)).toBe(true);
            expect(Number.isFinite(bounds.maxHeight)).toBe(true);
            expect(bounds.maxWidth).toBeGreaterThan(0);
            expect(bounds.maxHeight).toBeGreaterThan(0);
        });

        it('preserves the existing graph pane chrome subtraction for wide viewports', () => {
            expect(visualGraphBoundsForViewport({ columns: 200, rows: 40 })).toEqual({
                maxWidth: 194,
                maxHeight: 32,
            });
        });
    });

    describe('default width constant', () => {
        it('VISUAL_GRAPH_DEFAULT_WIDTH is 40', () => {
            expect(VISUAL_GRAPH_DEFAULT_WIDTH).toBe(40);
        });

        it('VISUAL_GRAPH_MAX_NODES is 16', () => {
            expect(VISUAL_GRAPH_MAX_NODES).toBe(16);
        });
    });

    describe('determinism', () => {
        it('produces identical output across repeated calls for the same input', () => {
            const input = {
                nodes: [node('a', 'succeeded'), node('b', 'running'), node('c', 'idle')],
                edges: [
                    { from: 'a', to: 'b' } satisfies VisualGraphEdge,
                    { from: 'b', to: 'c' } satisfies VisualGraphEdge,
                ],
                maxWidth: WIDE,
            };
            const first = renderVisualGraph(input);
            const second = renderVisualGraph(input);
            expect(second.lines).toEqual(first.lines);
            expect(second.rows).toEqual(first.rows);
        });
    });

    describe('status coverage', () => {
        it.each(AbgNodeStatusValues)('renders every node status glyph (%s)', (status) => {
            const result = renderVisualGraph({
                nodes: [node('n', status)],
                edges: [],
                maxWidth: WIDE,
            });
            expect(joinedLines(result)).toContain(`[${status}]`);
        });
    });
});
