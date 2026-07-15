import type { GraphLabel, NodeLabel } from '@dagrejs/dagre';
import { graphlib, layout } from '@dagrejs/dagre';
import type { AbgNodeStatus } from '@mission-control/protocol';
import { truncateTerminalText } from '@mission-control/tui';
import type { TerminalViewport } from '../platform/terminal-viewport';
import { nodeStatusTheme } from './abg-status-theme';

export type VisualGraphNode = {
    readonly nodeId: string;
    readonly status: AbgNodeStatus;
    readonly isActive: boolean;
};

export type VisualGraphEdge = {
    readonly from: string;
    readonly to: string;
    readonly label?: string;
};

export type VisualGraphInput = {
    readonly nodes: readonly VisualGraphNode[];
    readonly edges: readonly VisualGraphEdge[];
    readonly entryNodeId?: string;
    readonly maxNodes?: number;
    readonly maxWidth?: number;
};

export const VISUAL_GRAPH_MAX_NODES = 16;
export const VISUAL_GRAPH_DEFAULT_WIDTH = 40;
const GRAPH_PANE_MIN_WIDTH = 20;
const GRAPH_PANE_WIDTH_CHROME = 6;
const GRAPH_PANE_MIN_HEIGHT = 8;
const GRAPH_PANE_HEIGHT_CHROME = 8;

export type VisualGraphBounds = {
    readonly maxWidth: number;
    readonly maxHeight: number;
};

export function visualGraphBoundsForViewport(viewport: TerminalViewport): VisualGraphBounds {
    return {
        maxWidth: Math.max(GRAPH_PANE_MIN_WIDTH, viewport.columns - GRAPH_PANE_WIDTH_CHROME),
        maxHeight: Math.max(GRAPH_PANE_MIN_HEIGHT, viewport.rows - GRAPH_PANE_HEIGHT_CHROME),
    };
}

export type VisualGraphSegment = {
    readonly text: string;
    readonly status?: AbgNodeStatus;
};

export type VisualGraphRow = {
    readonly kind: 'node' | 'connector';
    readonly segments: readonly VisualGraphSegment[];
    readonly status?: AbgNodeStatus;
    readonly isActive?: boolean;
};

export type VisualGraphRender = {
    readonly rows: readonly VisualGraphRow[];
    readonly lines: readonly string[];
    readonly collapsed: boolean;
    readonly width: number;
};

// DESIGN.md S2 deterministic dagre options and node-box dimensions. Interior
// width 20 fits the longest status bracket `[succeeded]`/`[cancelled]` (11)
// alongside the glyph and a 6-char id (the DESIGN.md `✓ start [succeeded]`
// example needs ~18 content cols).
const NODE_CONTENT_WIDTH = 20;
const NODE_BOX_WIDTH = NODE_CONTENT_WIDTH + 2;
const NODE_BOX_HEIGHT = 3;
const SELF_LOOP_GLYPH = '\u21bb';
const LABEL_MAX = 8;

type Dir = 'N' | 'S' | 'E' | 'W';
type ArrowDir = 'down' | 'up' | 'right' | 'left';

type Cell = {
    ch: string;
    status?: AbgNodeStatus;
    dirs?: Set<Dir>;
    arrow?: ArrowDir;
    isNode: boolean;
    isActive?: boolean;
};

type NodePos = {
    readonly id: string;
    readonly cellX: number;
    readonly cellY: number;
    readonly status: AbgNodeStatus;
    readonly isActive: boolean;
};

/**
 * Deterministic 2-D coordinate renderer. Normalizes the protocol snapshot into a
 * dagre graph, runs layout with fixed options, converts float centers to integer
 * terminal cells, then draws a bounded text canvas with status-aware segments.
 * Returns a bounded summary when the graph exceeds the node budget; clips rows to
 * `maxWidth` when the laid-out canvas is too wide. Never falls back to an
 * adjacency tree for normal graph sizes.
 */
// allow: SIZE_OK -- coordinate renderer is one cohesive pipeline
export function renderVisualGraph(input: VisualGraphInput): VisualGraphRender {
    const maxNodes = input.maxNodes ?? VISUAL_GRAPH_MAX_NODES;
    const maxWidth = input.maxWidth ?? VISUAL_GRAPH_DEFAULT_WIDTH;

    if (input.nodes.length === 0) {
        return placeholderRender('(no nodes)', maxWidth);
    }
    if (input.nodes.length > maxNodes) {
        return renderSummary(input, maxWidth);
    }

    const { positions, selfLoops } = layoutNodes(input);
    if (positions.size === 0) {
        return placeholderRender('(no nodes)', maxWidth);
    }
    const { grid, height, width } = drawCanvas(input, positions, selfLoops);
    const rows = canvasToRows(grid, height, width, maxWidth);
    const lines = rows.map((row) =>
        row.segments
            .map((segment) => segment.text)
            .join('')
            .trimEnd(),
    );
    return { rows, lines, collapsed: false, width: Math.min(width, maxWidth) };
}

function placeholderRender(text: string, maxWidth: number): VisualGraphRender {
    const row: VisualGraphRow = { kind: 'connector', segments: [{ text }] };
    return { rows: [row], lines: [text], collapsed: false, width: maxWidth };
}

function renderSummary(input: VisualGraphInput, maxWidth: number): VisualGraphRender {
    const statusCounts = new Map<AbgNodeStatus, number>();
    for (const node of input.nodes) {
        statusCounts.set(node.status, (statusCounts.get(node.status) ?? 0) + 1);
    }
    const lines = [
        `(graph too large: ${input.nodes.length} nodes, ${input.edges.length} edges)`,
        ...[...statusCounts.entries()].map(([status, count]) => {
            const theme = nodeStatusTheme(status);
            return `${theme.glyph} ${status}: ${count}`;
        }),
    ];
    const rows: VisualGraphRow[] = lines.map((line) => ({ kind: 'connector', segments: [{ text: line }] }));
    return { rows, lines, collapsed: true, width: maxWidth };
}

function layoutNodes(input: VisualGraphInput): {
    readonly positions: Map<string, NodePos>;
    readonly selfLoops: Set<string>;
} {
    const graph = new graphlib.Graph<GraphLabel, NodeLabel>();
    graph.setGraph({ rankdir: 'TB', nodesep: 2, ranksep: 3, marginx: 1, marginy: 1 });
    graph.setDefaultNodeLabel(() => ({ width: NODE_BOX_WIDTH, height: NODE_BOX_HEIGHT }));
    graph.setDefaultEdgeLabel(() => ({}));

    const selfLoops = new Set<string>();
    const known = new Set<string>();
    for (const node of input.nodes) {
        if (known.has(node.nodeId)) continue;
        known.add(node.nodeId);
        graph.setNode(node.nodeId, { width: NODE_BOX_WIDTH, height: NODE_BOX_HEIGHT });
    }
    const placed = new Set<string>();
    for (const edge of input.edges) {
        if (edge.from === edge.to) {
            selfLoops.add(edge.from);
            continue;
        }
        if (!known.has(edge.from) || !known.has(edge.to)) continue;
        const key = `${edge.from}\u0001${edge.to}`;
        if (placed.has(key)) continue;
        placed.add(key);
        graph.setEdge(edge.from, edge.to);
    }

    layout(graph);

    const positions = new Map<string, NodePos>();
    const nodeById = new Map(input.nodes.map((node) => [node.nodeId, node]));
    for (const id of graph.nodes()) {
        const label = graph.node(id);
        const original = nodeById.get(id);
        if (label === undefined || original === undefined) continue;
        if (label.x === undefined || label.y === undefined) continue;
        const cellX = Math.round(label.x - NODE_BOX_WIDTH / 2);
        const cellY = Math.round(label.y - NODE_BOX_HEIGHT / 2);
        positions.set(id, { id, cellX, cellY, status: original.status, isActive: original.isActive });
    }
    return { positions, selfLoops };
}

function drawCanvas(
    input: VisualGraphInput,
    positions: Map<string, NodePos>,
    selfLoops: Set<string>,
): { readonly grid: Cell[][]; readonly height: number; readonly width: number } {
    let maxX = 0;
    let maxY = 0;
    for (const pos of positions.values()) {
        maxX = Math.max(maxX, pos.cellX + NODE_BOX_WIDTH);
        maxY = Math.max(maxY, pos.cellY + NODE_BOX_HEIGHT);
    }
    const width = maxX + 1;
    const height = maxY + 1;
    const grid: Cell[][] = Array.from({ length: height }, () =>
        Array.from({ length: width }, () => ({ ch: ' ', isNode: false }) as Cell),
    );

    for (const pos of positions.values()) {
        drawNodeBox(grid, width, height, pos, selfLoops.has(pos.id));
    }
    const labelsByPair = new Map<string, string>();
    for (const edge of input.edges) {
        if (edge.from === edge.to || edge.label === undefined) continue;
        labelsByPair.set(`${edge.from}\u0001${edge.to}`, edge.label);
    }
    for (const edge of input.edges) {
        if (edge.from === edge.to) continue;
        const src = positions.get(edge.from);
        const tgt = positions.get(edge.to);
        if (src === undefined || tgt === undefined) continue;
        drawEdge(grid, width, height, src, tgt);
    }
    for (const [pair, label] of labelsByPair) {
        const parts = pair.split('\u0001');
        const from = parts[0];
        const to = parts[1];
        if (from === undefined || to === undefined) continue;
        const src = positions.get(from);
        const tgt = positions.get(to);
        if (src === undefined || tgt === undefined) continue;
        drawLabel(grid, width, height, src, tgt, label);
    }
    return { grid, height, width };
}

function drawNodeBox(grid: Cell[][], width: number, height: number, pos: NodePos, hasSelfLoop: boolean): void {
    const { cellX: x, cellY: y, status, isActive } = pos;
    const glyph = nodeStatusTheme(status).glyph;
    const inBounds = (cx: number, cy: number): boolean => cy >= 0 && cy < height && cx >= 0 && cx < width;
    const paint = (cx: number, cy: number, ch: string): void => {
        if (!inBounds(cx, cy)) return;
        const cell: Cell = { ch, isNode: true, status };
        if (isActive) cell.isActive = true;
        const row = grid[cy];
        if (row !== undefined) row[cx] = cell;
    };

    paint(x, y, '\u250c');
    for (let i = 1; i < NODE_BOX_WIDTH - 1; i++) paint(x + i, y, '\u2500');
    paint(x + NODE_BOX_WIDTH - 1, y, '\u2510');

    const content = formatContent(glyph, pos.id, status, hasSelfLoop);
    paint(x, y + 1, '\u2502');
    for (let i = 0; i < NODE_CONTENT_WIDTH; i++) {
        const segment = content[i];
        paint(x + 1 + i, y + 1, segment === undefined ? ' ' : segment.ch);
    }
    paint(x + NODE_BOX_WIDTH - 1, y + 1, '\u2502');

    paint(x, y + 2, '\u2514');
    for (let i = 1; i < NODE_BOX_WIDTH - 1; i++) paint(x + i, y + 2, '\u2500');
    paint(x + NODE_BOX_WIDTH - 1, y + 2, '\u2518');
}

function formatContent(
    glyph: string,
    id: string,
    status: AbgNodeStatus,
    hasSelfLoop: boolean,
): readonly { readonly ch: string; readonly status?: AbgNodeStatus }[] {
    const statusLabel = `[${status}]`;
    const overhead = 1 + 1 + 1 + statusLabel.length + (hasSelfLoop ? 1 : 0);
    const idBudget = Math.max(1, NODE_CONTENT_WIDTH - overhead);
    const clippedId = truncate(id, idBudget);
    const cells: { ch: string; status?: AbgNodeStatus }[] = [];
    cells.push({ ch: glyph, status });
    cells.push({ ch: ' ' });
    for (const ch of clippedId) cells.push({ ch });
    cells.push({ ch: ' ' });
    for (const ch of statusLabel) cells.push({ ch, status });
    if (hasSelfLoop) cells.push({ ch: SELF_LOOP_GLYPH, status });
    while (cells.length < NODE_CONTENT_WIDTH) cells.push({ ch: ' ' });
    return cells;
}

function drawEdge(grid: Cell[][], width: number, height: number, src: NodePos, tgt: NodePos): void {
    const srcCx = src.cellX + Math.floor(NODE_BOX_WIDTH / 2);
    const tgtCx = tgt.cellX + Math.floor(NODE_BOX_WIDTH / 2);
    const sameRank = Math.abs(tgt.cellY - src.cellY) < NODE_BOX_HEIGHT;
    if (sameRank) {
        drawHorizontalEdge(grid, width, height, src, tgt);
        return;
    }
    const down = tgt.cellY > src.cellY;
    const srcY = down ? src.cellY + NODE_BOX_HEIGHT : src.cellY - 1;
    const tgtY = down ? tgt.cellY - 1 : tgt.cellY + NODE_BOX_HEIGHT;
    if (srcCx === tgtCx) {
        addVertical(grid, width, height, srcCx, srcY, tgtY);
    } else {
        const midY = Math.floor((srcY + tgtY) / 2);
        addVertical(grid, width, height, srcCx, srcY, midY);
        addHorizontal(grid, width, height, srcCx, tgtCx, midY);
        addVertical(grid, width, height, tgtCx, midY, tgtY);
    }
    markArrow(grid, width, height, tgtCx, tgtY, down ? 'down' : 'up');
}

function drawHorizontalEdge(grid: Cell[][], width: number, height: number, src: NodePos, tgt: NodePos): void {
    const row = src.cellY + 1;
    const srcRx = src.cellX + NODE_BOX_WIDTH;
    const tgtLx = tgt.cellX - 1;
    const lo = Math.min(srcRx, tgtLx);
    const hi = Math.max(srcRx, tgtLx);
    for (let cx = lo; cx <= hi; cx++) markDirs(grid, width, height, cx, row, new Set<Dir>(['E', 'W']));
    const pointsRight = tgt.cellX > src.cellX;
    markArrow(grid, width, height, tgtLx, row, pointsRight ? 'right' : 'left');
}

function addVertical(grid: Cell[][], width: number, height: number, x: number, y1: number, y2: number): void {
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    for (let cy = lo; cy <= hi; cy++) {
        const dirs = new Set<Dir>();
        if (cy > lo) dirs.add('N');
        if (cy < hi) dirs.add('S');
        markDirs(grid, width, height, x, cy, dirs);
    }
}

function addHorizontal(grid: Cell[][], width: number, height: number, x1: number, x2: number, y: number): void {
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    for (let cx = lo; cx <= hi; cx++) {
        const dirs = new Set<Dir>();
        if (cx > lo) dirs.add('W');
        if (cx < hi) dirs.add('E');
        markDirs(grid, width, height, cx, y, dirs);
    }
}

function markDirs(grid: Cell[][], width: number, height: number, x: number, y: number, dirs: Set<Dir>): void {
    const cell = getCell(grid, width, height, x, y);
    if (cell === undefined || cell.isNode) return;
    if (cell.dirs === undefined) cell.dirs = new Set();
    for (const dir of dirs) cell.dirs.add(dir);
}

function markArrow(grid: Cell[][], width: number, height: number, x: number, y: number, arrow: ArrowDir): void {
    const cell = getCell(grid, width, height, x, y);
    if (cell === undefined || cell.isNode) return;
    cell.arrow = arrow;
}

function getCell(grid: Cell[][], width: number, height: number, x: number, y: number): Cell | undefined {
    if (y < 0 || y >= height || x < 0 || x >= width) return undefined;
    return grid[y]?.[x];
}

function drawLabel(grid: Cell[][], width: number, height: number, src: NodePos, tgt: NodePos, label: string): void {
    const down = tgt.cellY > src.cellY;
    const srcY = down ? src.cellY + NODE_BOX_HEIGHT : src.cellY - 1;
    const srcCx = src.cellX + Math.floor(NODE_BOX_WIDTH / 2);
    const startY = down ? srcY : Math.min(srcY, tgt.cellY - 1);
    const text = `[${truncate(label, LABEL_MAX)}]`;
    for (let i = 0; i < text.length; i++) {
        const cx = srcCx + 1 + i;
        const cell = getCell(grid, width, height, cx, startY);
        if (cell === undefined || cell.isNode) continue;
        cell.ch = text[i] ?? '?';
        delete cell.dirs;
        delete cell.arrow;
    }
}

function canvasToRows(grid: Cell[][], height: number, width: number, maxWidth: number): VisualGraphRow[] {
    const effectiveWidth = Math.min(width, maxWidth);
    const rows: VisualGraphRow[] = [];
    for (let y = 0; y < height; y++) {
        const gridRow = grid[y];
        if (gridRow === undefined) continue;
        const segments = buildRowSegments(gridRow, effectiveWidth);
        if (segments.length === 0) continue;
        const nodeStatus = firstNodeStatus(gridRow, effectiveWidth);
        const active = rowHasActive(gridRow, effectiveWidth);
        const kind: 'node' | 'connector' = nodeStatus !== undefined ? 'node' : 'connector';
        const outRow: VisualGraphRow = {
            kind,
            segments,
            ...(nodeStatus !== undefined ? { status: nodeStatus } : {}),
            ...(active ? { isActive: true } : {}),
        };
        rows.push(outRow);
    }
    return rows;
}

function buildRowSegments(row: Cell[], effectiveWidth: number): readonly VisualGraphSegment[] {
    const segments: VisualGraphSegment[] = [];
    let buffer = '';
    let bufferStatus: AbgNodeStatus | undefined;
    for (let x = 0; x < effectiveWidth; x++) {
        const cell = row[x];
        if (cell === undefined) continue;
        const ch = resolveGlyph(cell);
        const segStatus = cell.isNode ? cell.status : undefined;
        if (segStatus !== bufferStatus) {
            if (buffer.length > 0) {
                segments.push(makeSegment(buffer, bufferStatus));
            }
            buffer = ch;
            bufferStatus = segStatus;
        } else {
            buffer += ch;
        }
    }
    if (buffer.trim().length > 0) {
        segments.push(makeSegment(buffer, bufferStatus));
    }
    return segments;
}

function makeSegment(text: string, status: AbgNodeStatus | undefined): VisualGraphSegment {
    if (status !== undefined) return { text, status };
    return { text };
}

function resolveGlyph(cell: Cell): string {
    if (cell.arrow !== undefined) {
        switch (cell.arrow) {
            case 'down':
                return '\u25bc';
            case 'up':
                return '\u25b2';
            case 'right':
                return '\u25ba';
            case 'left':
                return '\u25c4';
        }
    }
    if (cell.dirs !== undefined && cell.dirs.size > 0) {
        return dirsToGlyph(cell.dirs);
    }
    return cell.ch;
}

function dirsToGlyph(dirs: Set<Dir>): string {
    const has = (dir: Dir): boolean => dirs.has(dir);
    const n = has('N');
    const s = has('S');
    const e = has('E');
    const w = has('W');
    if (n && s && e && w) return '\u253c';
    if (n && s && e) return '\u251c';
    if (n && s && w) return '\u2524';
    if (s && e && w) return '\u252c';
    if (n && e && w) return '\u2534';
    if (n && s) return '\u2502';
    if (e && w) return '\u2500';
    if (s && e) return '\u250c';
    if (s && w) return '\u2510';
    if (n && e) return '\u2514';
    if (n && w) return '\u2518';
    if (n || s) return '\u2502';
    if (e || w) return '\u2500';
    return '\u00b7';
}

function firstNodeStatus(row: Cell[], effectiveWidth: number): AbgNodeStatus | undefined {
    for (let x = 0; x < effectiveWidth; x++) {
        const cell = row[x];
        if (cell?.isNode === true && cell.status !== undefined) return cell.status;
    }
    return undefined;
}

function rowHasActive(row: Cell[], effectiveWidth: number): boolean {
    for (let x = 0; x < effectiveWidth; x++) {
        const cell = row[x];
        if (cell !== undefined && cell.isActive === true) return true;
    }
    return false;
}

function truncate(text: string, max: number): string {
    if (max <= 0) return '';
    return truncateTerminalText(text, max, '\u2026');
}
