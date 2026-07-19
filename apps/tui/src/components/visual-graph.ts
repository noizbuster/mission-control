import type { AbgNodeStatus } from '@mission-control/protocol';
import { truncateTerminalText } from '../terminal-text';
import { nodeStatusTheme } from './abg-status-theme';
import { createGraphCanvas, drawNodeBoxes } from './visual-graph-canvas';
import { drawGraphEdges } from './visual-graph-edges';
import { layoutGraph } from './visual-graph-layout';
import { graphCanvasToRows } from './visual-graph-rows';
import {
    VISUAL_GRAPH_DEFAULT_WIDTH,
    VISUAL_GRAPH_MAX_NODES,
    type VisualGraphInput,
    type VisualGraphRender,
    type VisualGraphRow,
} from './visual-graph-types';

export type {
    VisualGraphBounds,
    VisualGraphEdge,
    VisualGraphInput,
    VisualGraphNode,
    VisualGraphRender,
    VisualGraphRow,
    VisualGraphSegment,
} from './visual-graph-types';
export {
    VISUAL_GRAPH_DEFAULT_WIDTH,
    VISUAL_GRAPH_MAX_NODES,
    visualGraphBoundsForViewport,
} from './visual-graph-types';

export function renderVisualGraph(input: VisualGraphInput): VisualGraphRender {
    const maxNodes = input.maxNodes ?? VISUAL_GRAPH_MAX_NODES;
    const maxWidth = normalizePositiveInteger(input.maxWidth ?? VISUAL_GRAPH_DEFAULT_WIDTH);
    const offsetX = Math.max(0, Math.trunc(input.offsetX ?? 0));
    const offsetY = Math.max(0, Math.trunc(input.offsetY ?? 0));
    const maxHeight = input.maxHeight === undefined ? undefined : Math.max(1, Math.trunc(input.maxHeight));

    if (input.nodes.length === 0) return placeholderRender('(no nodes)', maxWidth);
    if (input.nodes.length > maxNodes) return renderSummary(input, maxWidth);

    const { positions, selfLoops } = layoutGraph(input);
    if (positions.size === 0) return placeholderRender('(no nodes)', maxWidth);

    const canvas = createGraphCanvas(positions);
    drawNodeBoxes(canvas, positions, selfLoops);
    drawGraphEdges(canvas, input.edges, positions);

    const clampedX = clampOffset(offsetX, canvas.width, maxWidth);
    const clampedY = clampOffset(offsetY, canvas.height, maxHeight ?? canvas.height);
    const rows = graphCanvasToRows(canvas, maxWidth, clampedX, clampedY, maxHeight);
    return {
        rows,
        lines: rows.map(joinRowSegments),
        collapsed: false,
        width: Math.min(canvas.width, maxWidth),
        fullWidth: canvas.width,
        fullHeight: canvas.height,
        offsetX: clampedX,
        offsetY: clampedY,
        pannable: canvas.width > maxWidth || canvas.height > (maxHeight ?? canvas.height),
    };
}

export function clampGraphPanOffset(offset: number, contentSize: number, viewportSize: number): number {
    return clampOffset(Math.max(0, Math.trunc(offset)), contentSize, Math.max(1, Math.trunc(viewportSize)));
}

function clampOffset(offset: number, contentSize: number, viewportSize: number): number {
    if (contentSize <= viewportSize) return 0;
    return Math.max(0, Math.min(offset, contentSize - viewportSize));
}

function placeholderRender(text: string, maxWidth: number): VisualGraphRender {
    const line = truncateTerminalText(text, maxWidth);
    const row: VisualGraphRow = { kind: 'connector', segments: [{ text: line }] };
    return {
        rows: [row],
        lines: [line],
        collapsed: false,
        width: maxWidth,
        fullWidth: maxWidth,
        fullHeight: 1,
        offsetX: 0,
        offsetY: 0,
        pannable: false,
    };
}

function renderSummary(input: VisualGraphInput, maxWidth: number): VisualGraphRender {
    const statusCounts = new Map<AbgNodeStatus, number>();
    for (const node of input.nodes) {
        statusCounts.set(node.status, (statusCounts.get(node.status) ?? 0) + 1);
    }
    const lines = [
        `(graph too large: ${input.nodes.length} nodes, ${input.edges.length} edges — pan unavailable above ${input.maxNodes ?? VISUAL_GRAPH_MAX_NODES})`,
        ...[...statusCounts.entries()].map(([status, count]) => {
            const theme = nodeStatusTheme(status);
            return `${theme.glyph} ${status}: ${count}`;
        }),
    ].map((line) => truncateTerminalText(line, maxWidth));
    const rows: VisualGraphRow[] = lines.map((text) => ({ kind: 'connector', segments: [{ text }] }));
    return {
        rows,
        lines,
        collapsed: true,
        width: maxWidth,
        fullWidth: maxWidth,
        fullHeight: rows.length,
        offsetX: 0,
        offsetY: 0,
        pannable: false,
    };
}

function joinRowSegments(row: VisualGraphRow): string {
    return row.segments
        .map((segment) => segment.text)
        .join('')
        .trimEnd();
}

function normalizePositiveInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}
