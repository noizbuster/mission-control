import type { AbgNodeStatus } from '@mission-control/protocol';
import { terminalDisplayWidth } from '@mission-control/tui';
import { type GraphCanvas, type GraphCell, resolveGraphGlyph } from './visual-graph-canvas';
import type { VisualGraphRow, VisualGraphSegment } from './visual-graph-types';

export function graphCanvasToRows(
    canvas: GraphCanvas,
    maxWidth: number,
    offsetX: number,
    offsetY: number,
    maxHeight: number | undefined,
): readonly VisualGraphRow[] {
    const viewportWidth = Math.min(canvas.width, maxWidth);
    const startY = Math.min(offsetY, Math.max(0, canvas.height - 1));
    const endY = maxHeight === undefined ? canvas.height : Math.min(canvas.height, startY + maxHeight);
    const rows: VisualGraphRow[] = [];
    for (let y = startY; y < endY; y++) {
        const gridRow = canvas.grid[y];
        if (gridRow === undefined) continue;
        const segments = buildRowSegments(gridRow, offsetX, viewportWidth);
        if (segments.length === 0) continue;
        const nodeStatus = firstNodeStatus(gridRow, offsetX, viewportWidth);
        const active = rowHasActive(gridRow, offsetX, viewportWidth);
        rows.push({
            kind: nodeStatus === undefined ? 'connector' : 'node',
            segments,
            ...(nodeStatus === undefined ? {} : { status: nodeStatus }),
            ...(active ? { isActive: true } : {}),
        });
    }
    return rows;
}

function buildRowSegments(
    row: readonly GraphCell[],
    offsetX: number,
    viewportWidth: number,
): readonly VisualGraphSegment[] {
    const segments: VisualGraphSegment[] = [];
    let buffer = '';
    let bufferStatus: AbgNodeStatus | undefined;
    const append = (text: string, status: AbgNodeStatus | undefined): void => {
        if (status !== bufferStatus && buffer.length > 0) {
            segments.push(makeSegment(buffer, bufferStatus));
            buffer = '';
        }
        bufferStatus = status;
        buffer += text;
    };

    for (let index = 0; index < viewportWidth; index++) {
        const cell = row[offsetX + index];
        if (cell === undefined) continue;
        const status = cell.isNode ? cell.status : undefined;
        if (cell.continuationStart !== undefined) {
            if (cell.continuationStart < offsetX) append(' ', status);
            continue;
        }
        const glyph = resolveGraphGlyph(cell);
        const glyphWidth = terminalDisplayWidth(glyph);
        if (glyphWidth > viewportWidth - index) {
            append(' '.repeat(viewportWidth - index), status);
            continue;
        }
        append(glyph, status);
    }
    if (buffer.trim().length > 0) segments.push(makeSegment(buffer, bufferStatus));
    return segments;
}

function makeSegment(text: string, status: AbgNodeStatus | undefined): VisualGraphSegment {
    return status === undefined ? { text } : { text, status };
}

function firstNodeStatus(row: readonly GraphCell[], offsetX: number, viewportWidth: number): AbgNodeStatus | undefined {
    for (let index = 0; index < viewportWidth; index++) {
        const cell = row[offsetX + index];
        if (cell?.isNode === true && cell.status !== undefined) return cell.status;
    }
    return undefined;
}

function rowHasActive(row: readonly GraphCell[], offsetX: number, viewportWidth: number): boolean {
    for (let index = 0; index < viewportWidth; index++) {
        if (row[offsetX + index]?.isActive === true) return true;
    }
    return false;
}
