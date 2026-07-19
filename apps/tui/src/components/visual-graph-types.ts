import type { AbgNodeStatus } from '@mission-control/protocol';
import type { TerminalViewport } from '../platform/terminal-viewport';

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
    readonly offsetX?: number;
    readonly offsetY?: number;
    readonly maxHeight?: number;
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
    readonly fullWidth: number;
    readonly fullHeight: number;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly pannable: boolean;
};
