import { segmentTerminalText, terminalDisplayWidth, truncateTerminalText } from '@mission-control/tui';
import {
    type Direction,
    type GraphCanvas,
    getGraphCell,
    markGraphArrow,
    markGraphDirections,
} from './visual-graph-canvas';
import { NODE_BOX_HEIGHT, NODE_BOX_WIDTH, type NodePosition } from './visual-graph-layout';
import type { VisualGraphEdge } from './visual-graph-types';

const LABEL_MAX = 8;

export function drawGraphEdges(
    canvas: GraphCanvas,
    edges: readonly VisualGraphEdge[],
    positions: ReadonlyMap<string, NodePosition>,
): void {
    for (const edge of edges) {
        if (edge.from === edge.to) continue;
        const source = positions.get(edge.from);
        const target = positions.get(edge.to);
        if (source === undefined || target === undefined) continue;
        drawEdge(canvas, source, target);
    }

    const labelsBySource = new Map<string, Map<string, VisualGraphEdge>>();
    for (const edge of edges) {
        if (edge.from === edge.to || edge.label === undefined) continue;
        const labelsByTarget = labelsBySource.get(edge.from);
        if (labelsByTarget === undefined) {
            labelsBySource.set(edge.from, new Map([[edge.to, edge]]));
        } else {
            labelsByTarget.set(edge.to, edge);
        }
    }
    for (const labelsByTarget of labelsBySource.values()) {
        for (const edge of labelsByTarget.values()) {
            const label = edge.label;
            if (label === undefined) continue;
            const source = positions.get(edge.from);
            const target = positions.get(edge.to);
            if (source === undefined || target === undefined) continue;
            drawLabel(canvas, source, target, label);
        }
    }
}

function drawEdge(canvas: GraphCanvas, source: NodePosition, target: NodePosition): void {
    const sourceCenterX = source.cellX + Math.floor(NODE_BOX_WIDTH / 2);
    const targetCenterX = target.cellX + Math.floor(NODE_BOX_WIDTH / 2);
    if (Math.abs(target.cellY - source.cellY) < NODE_BOX_HEIGHT) {
        drawHorizontalEdge(canvas, source, target);
        return;
    }
    const pointsDown = target.cellY > source.cellY;
    const sourceY = pointsDown ? source.cellY + NODE_BOX_HEIGHT : source.cellY - 1;
    const targetY = pointsDown ? target.cellY - 1 : target.cellY + NODE_BOX_HEIGHT;
    if (sourceCenterX === targetCenterX) {
        addVertical(canvas, sourceCenterX, sourceY, targetY);
    } else {
        const middleY = Math.floor((sourceY + targetY) / 2);
        addVertical(canvas, sourceCenterX, sourceY, middleY);
        addHorizontal(canvas, sourceCenterX, targetCenterX, middleY);
        addVertical(canvas, targetCenterX, middleY, targetY);
    }
    markGraphArrow(canvas, targetCenterX, targetY, pointsDown ? 'down' : 'up');
}

function drawHorizontalEdge(canvas: GraphCanvas, source: NodePosition, target: NodePosition): void {
    const row = source.cellY + 1;
    const sourceRight = source.cellX + NODE_BOX_WIDTH;
    const targetLeft = target.cellX - 1;
    for (let column = Math.min(sourceRight, targetLeft); column <= Math.max(sourceRight, targetLeft); column++) {
        markGraphDirections(canvas, column, row, new Set<Direction>(['E', 'W']));
    }
    markGraphArrow(canvas, targetLeft, row, target.cellX > source.cellX ? 'right' : 'left');
}

function addVertical(canvas: GraphCanvas, x: number, y1: number, y2: number): void {
    const low = Math.min(y1, y2);
    const high = Math.max(y1, y2);
    for (let y = low; y <= high; y++) {
        const directions = new Set<Direction>();
        if (y > low) directions.add('N');
        if (y < high) directions.add('S');
        markGraphDirections(canvas, x, y, directions);
    }
}

function addHorizontal(canvas: GraphCanvas, x1: number, x2: number, y: number): void {
    const low = Math.min(x1, x2);
    const high = Math.max(x1, x2);
    for (let x = low; x <= high; x++) {
        const directions = new Set<Direction>();
        if (x > low) directions.add('W');
        if (x < high) directions.add('E');
        markGraphDirections(canvas, x, y, directions);
    }
}

function drawLabel(canvas: GraphCanvas, source: NodePosition, target: NodePosition, displayLabel: string): void {
    const pointsDown = target.cellY > source.cellY;
    const sourceY = pointsDown ? source.cellY + NODE_BOX_HEIGHT : source.cellY - 1;
    const startY = pointsDown ? sourceY : Math.min(sourceY, target.cellY - 1);
    const startX = source.cellX + Math.floor(NODE_BOX_WIDTH / 2) + 1;
    const text = `[${truncateTerminalText(displayLabel, LABEL_MAX, '\u2026')}]`;
    let x = startX;
    for (const { segment } of segmentTerminalText(text)) {
        const width = terminalDisplayWidth(segment);
        if (width === 0 || !canPaintLabel(canvas, x, startY, width)) {
            x += width;
            continue;
        }
        paintLabelGrapheme(canvas, x, startY, segment, width);
        x += width;
    }
}

function canPaintLabel(canvas: GraphCanvas, x: number, y: number, width: number): boolean {
    for (let offset = 0; offset < width; offset++) {
        const cell = getGraphCell(canvas, x + offset, y);
        if (cell === undefined || cell.isNode) return false;
    }
    return true;
}

function paintLabelGrapheme(canvas: GraphCanvas, x: number, y: number, grapheme: string, width: number): void {
    for (let offset = 0; offset < width; offset++) {
        const cell = getGraphCell(canvas, x + offset, y);
        if (cell === undefined) continue;
        cell.ch = offset === 0 ? grapheme : '';
        if (offset > 0) cell.continuationStart = x;
        delete cell.dirs;
        delete cell.arrow;
    }
}
