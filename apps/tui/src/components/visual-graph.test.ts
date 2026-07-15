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

    describe('fan-out (one source to many targets)', () => {
        const result = renderVisualGraph({
            nodes: [
                node('parent', 'succeeded'),
                node('child1', 'running', true),
                node('child2', 'idle'),
                node('child3', 'idle'),
            ],
            edges: [
                { from: 'parent', to: 'child1' },
                { from: 'parent', to: 'child2' },
                { from: 'parent', to: 'child3' },
            ],
            maxWidth: WIDE,
        });

        it('renders the source once and every target once', () => {
            const text = joinedLines(result);
            expect(occurrences(text, 'parent')).toBe(1);
            expect(occurrences(text, 'child1')).toBe(1);
            expect(occurrences(text, 'child2')).toBe(1);
            expect(occurrences(text, 'child3')).toBe(1);
        });

        it('draws a branching bus with down arrowheads to each target', () => {
            const text = joinedLines(result);
            const arrowheads = occurrences(text, '\u25bc');
            expect(arrowheads).toBe(3);
        });
    });

    describe('fan-in / join (two sources into one target)', () => {
        const result = renderVisualGraph({
            nodes: [node('a', 'succeeded'), node('b', 'succeeded'), node('c', 'running', true)],
            edges: [
                { from: 'a', to: 'c' },
                { from: 'b', to: 'c' },
            ],
            maxWidth: WIDE,
        });

        it('renders the join target exactly once (not duplicated)', () => {
            const text = joinedLines(result);
            expect(occurrences(text, 'c [running]')).toBe(1);
            expect(occurrences(text, '[running]')).toBe(1);
        });

        it('renders both sources once', () => {
            const text = joinedLines(result);
            expect(occurrences(text, 'a [')).toBe(1);
            expect(occurrences(text, 'b [')).toBe(1);
        });

        it('draws connectors from both sources converging on the target', () => {
            const text = joinedLines(result);
            expect(text).toContain('\u2502');
            expect(text).toContain('\u25bc');
        });
    });

    describe('self-loop (A->A)', () => {
        it('renders the self-loop glyph on the node content row', () => {
            const result = renderVisualGraph({
                nodes: [node('work', 'running', true)],
                edges: [{ from: 'work', to: 'work' }],
                maxWidth: WIDE,
            });
            expect(result.collapsed).toBe(false);
            expect(joinedLines(result)).toContain('\u21bb'); // self-loop glyph
        });
    });

    describe('back-edge / cycle (A->B->C->A)', () => {
        it('renders all cycle nodes and an upward back-edge arrowhead', () => {
            const result = renderVisualGraph({
                nodes: [node('a', 'running', true), node('b', 'idle'), node('c', 'idle')],
                edges: [
                    { from: 'a', to: 'b' },
                    { from: 'b', to: 'c' },
                    { from: 'c', to: 'a' },
                ],
                maxWidth: WIDE,
            });
            const text = joinedLines(result);
            expect(text).toContain('a [');
            expect(text).toContain('b [');
            expect(text).toContain('c [');
            expect(text).toContain('\u25b2'); // up arrowhead (back-edge)
        });
    });

    describe('disconnected node', () => {
        it('renders the disconnected node alongside the connected component', () => {
            const result = renderVisualGraph({
                nodes: [node('a', 'succeeded'), node('b', 'idle'), node('orphan', 'idle')],
                edges: [{ from: 'a', to: 'b' }],
                maxWidth: WIDE,
            });
            const text = joinedLines(result);
            expect(text).toContain('orphan');
            expect(text).toContain('a [');
            expect(text).toContain('b [');
            expect(text).toContain('\u25bc');
        });
    });

    describe('long label clipping', () => {
        it('truncates node ids that exceed the box interior', () => {
            const longId = 'x'.repeat(60);
            const result = renderVisualGraph({
                nodes: [node(longId, 'running')],
                edges: [],
                maxWidth: WIDE,
            });
            const text = joinedLines(result);
            expect(text).toContain('\u2026'); // ellipsis
            expect(text).not.toContain(longId);
        });

        it('truncates long edge labels', () => {
            const result = renderVisualGraph({
                nodes: [node('a', 'succeeded'), node('b', 'running')],
                edges: [{ from: 'a', to: 'b', label: 'a'.repeat(40) }],
                maxWidth: WIDE,
            });
            const text = joinedLines(result);
            expect(text).toContain('\u2026');
        });
    });

    describe('narrow canvas clipping', () => {
        it('bounds every output line to maxWidth', () => {
            const narrow = 12;
            const result = renderVisualGraph({
                nodes: [node('start', 'succeeded'), node('end', 'idle')],
                edges: [{ from: 'start', to: 'end' }],
                maxWidth: narrow,
            });
            expect(result.collapsed).toBe(false);
            for (const line of result.lines) {
                expect(line.length).toBeLessThanOrEqual(narrow);
            }
            expect(result.width).toBe(narrow);
        });

        it('still surfaces node glyphs when clipped', () => {
            const result = renderVisualGraph({
                nodes: [node('start', 'succeeded')],
                edges: [],
                maxWidth: 8,
            });
            expect(joinedLines(result)).toContain('\u2713');
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

function occurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
