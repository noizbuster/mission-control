import type { AbgNodeStatus } from '@mission-control/protocol';
import { segmentTerminalText, terminalDisplayWidth, truncateTerminalText } from '@mission-control/tui';
import { nodeStatusTheme } from './abg-status-theme';
import { NODE_BOX_HEIGHT, NODE_BOX_WIDTH, NODE_CONTENT_WIDTH, type NodePosition } from './visual-graph-layout';

export type Direction = 'N' | 'S' | 'E' | 'W';
export type ArrowDirection = 'down' | 'up' | 'right' | 'left';

export type GraphCell = {
    ch: string;
    status?: AbgNodeStatus;
    dirs?: Set<Direction>;
    arrow?: ArrowDirection;
    isNode: boolean;
    isActive?: boolean;
    continuationStart?: number;
};

export type GraphCanvas = {
    readonly grid: GraphCell[][];
    readonly height: number;
    readonly width: number;
};

const SELF_LOOP_GLYPH = '\u21bb';

export function createGraphCanvas(positions: ReadonlyMap<string, NodePosition>): GraphCanvas {
    let maxX = 0;
    let maxY = 0;
    for (const position of positions.values()) {
        maxX = Math.max(maxX, position.cellX + NODE_BOX_WIDTH);
        maxY = Math.max(maxY, position.cellY + NODE_BOX_HEIGHT);
    }
    const width = maxX + 1;
    const height = maxY + 1;
    return {
        grid: Array.from({ length: height }, () =>
            Array.from({ length: width }, () => ({ ch: ' ', isNode: false }) as GraphCell),
        ),
        height,
        width,
    };
}

export function drawNodeBoxes(
    canvas: GraphCanvas,
    positions: ReadonlyMap<string, NodePosition>,
    selfLoops: ReadonlySet<string>,
): void {
    for (const position of positions.values()) {
        drawNodeBox(canvas, position, selfLoops.has(position.id));
    }
}

export function getGraphCell(canvas: GraphCanvas, x: number, y: number): GraphCell | undefined {
    if (y < 0 || y >= canvas.height || x < 0 || x >= canvas.width) return undefined;
    return canvas.grid[y]?.[x];
}

export function markGraphDirections(
    canvas: GraphCanvas,
    x: number,
    y: number,
    directions: ReadonlySet<Direction>,
): void {
    const cell = getGraphCell(canvas, x, y);
    if (cell === undefined || cell.isNode) return;
    if (cell.dirs === undefined) cell.dirs = new Set();
    for (const direction of directions) cell.dirs.add(direction);
}

export function markGraphArrow(canvas: GraphCanvas, x: number, y: number, arrow: ArrowDirection): void {
    const cell = getGraphCell(canvas, x, y);
    if (cell === undefined || cell.isNode) return;
    cell.arrow = arrow;
}

export function resolveGraphGlyph(cell: GraphCell): string {
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
    if (cell.dirs !== undefined && cell.dirs.size > 0) return directionsToGlyph(cell.dirs);
    return cell.ch;
}

function drawNodeBox(canvas: GraphCanvas, position: NodePosition, hasSelfLoop: boolean): void {
    const { cellX: x, cellY: y, status, isActive } = position;
    const paint = (cellX: number, cellY: number, ch: string): void => {
        const cell = getGraphCell(canvas, cellX, cellY);
        if (cell === undefined) return;
        cell.ch = ch;
        cell.status = status;
        cell.isNode = true;
        if (isActive) cell.isActive = true;
    };

    paint(x, y, '\u250c');
    for (let column = 1; column < NODE_BOX_WIDTH - 1; column++) paint(x + column, y, '\u2500');
    paint(x + NODE_BOX_WIDTH - 1, y, '\u2510');
    paint(x, y + 1, '\u2502');
    paintNodeContent(canvas, x + 1, y + 1, nodeContent(position, hasSelfLoop));
    paint(x + NODE_BOX_WIDTH - 1, y + 1, '\u2502');
    paint(x, y + 2, '\u2514');
    for (let column = 1; column < NODE_BOX_WIDTH - 1; column++) paint(x + column, y + 2, '\u2500');
    paint(x + NODE_BOX_WIDTH - 1, y + 2, '\u2518');
}

function nodeContent(position: NodePosition, hasSelfLoop: boolean): readonly GraphTextPart[] {
    const glyph = nodeStatusTheme(position.status).glyph;
    const suffix = ` [${position.status}]${hasSelfLoop ? SELF_LOOP_GLYPH : ''}`;
    const idBudget = Math.max(0, NODE_CONTENT_WIDTH - terminalDisplayWidth(glyph) - 1 - terminalDisplayWidth(suffix));
    return [
        { text: glyph, status: position.status },
        { text: ' ' },
        { text: truncateTerminalText(position.id, idBudget, '\u2026') },
        { text: suffix, status: position.status },
    ];
}

type GraphTextPart = {
    readonly text: string;
    readonly status?: AbgNodeStatus;
};

function paintNodeContent(canvas: GraphCanvas, x: number, y: number, parts: readonly GraphTextPart[]): void {
    let column = x;
    const endColumn = x + NODE_CONTENT_WIDTH;
    for (const part of parts) {
        for (const { segment } of segmentTerminalText(part.text)) {
            const width = terminalDisplayWidth(segment);
            if (width === 0 || column + width > endColumn) continue;
            paintNodeGrapheme(canvas, column, y, segment, width, part.status);
            column += width;
        }
    }
    while (column < endColumn) {
        paintNodeGrapheme(canvas, column, y, ' ', 1, undefined);
        column++;
    }
}

function paintNodeGrapheme(
    canvas: GraphCanvas,
    x: number,
    y: number,
    grapheme: string,
    width: number,
    status: AbgNodeStatus | undefined,
): void {
    for (let offset = 0; offset < width; offset++) {
        const cell = getGraphCell(canvas, x + offset, y);
        if (cell === undefined) continue;
        cell.ch = offset === 0 ? grapheme : '';
        if (status === undefined) {
            delete cell.status;
        } else {
            cell.status = status;
        }
        cell.isNode = true;
        if (offset > 0) cell.continuationStart = x;
    }
}

function directionsToGlyph(directions: ReadonlySet<Direction>): string {
    const has = (direction: Direction): boolean => directions.has(direction);
    const north = has('N');
    const south = has('S');
    const east = has('E');
    const west = has('W');
    if (north && south && east && west) return '\u253c';
    if (north && south && east) return '\u251c';
    if (north && south && west) return '\u2524';
    if (south && east && west) return '\u252c';
    if (north && east && west) return '\u2534';
    if (north && south) return '\u2502';
    if (east && west) return '\u2500';
    if (south && east) return '\u250c';
    if (south && west) return '\u2510';
    if (north && east) return '\u2514';
    if (north && west) return '\u2518';
    if (north || south) return '\u2502';
    if (east || west) return '\u2500';
    return '\u00b7';
}
