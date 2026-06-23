import type { AbgNodeStatus } from '@mission-control/protocol';

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

export type VisualGraphSegment = {
    readonly text: string;
    /**
     * When set, the segment is status-tinted (consumer applies {@link statusColor}). Carried on
     * each segment — not the row — so a single node line can mix colored (glyph, `[status]`) and
     * neutral (node id, connectors) runs without the consumer re-deriving status boundaries.
     */
    readonly status?: AbgNodeStatus;
};

export type VisualGraphRow = {
    readonly kind: 'node' | 'connector';
    readonly segments: readonly VisualGraphSegment[];
    /** Node rows only: the node's status, so the consumer can spin running/starting nodes. */
    readonly status?: AbgNodeStatus;
    /** Node rows only: whether this node is the graph's active node (spinner candidate). */
    readonly isActive?: boolean;
};

export type VisualGraphRender = {
    /** Structured rows for colorized React rendering (per-segment status, per-node active flag). */
    readonly rows: readonly VisualGraphRow[];
    /** Flat `rows` joined to plain strings — backward-compatible view for tests and plain renderers. */
    readonly lines: readonly string[];
    readonly collapsed: boolean;
};

const STATUS_GLYPH: Readonly<Record<AbgNodeStatus, string>> = {
    starting: '○',
    running: '▶',
    succeeded: '✓',
    failed: '✗',
    blocked: '⏸',
    cancelled: '⊘',
    idle: '∙',
};

const STATUS_COLOR: Readonly<Record<AbgNodeStatus, string>> = {
    starting: 'dim',
    running: 'yellow',
    succeeded: 'green',
    failed: 'red',
    blocked: 'cyan',
    cancelled: 'gray',
    idle: 'dim',
};

export function statusGlyph(status: AbgNodeStatus): string {
    return STATUS_GLYPH[status] ?? '○';
}

export function statusColor(status: AbgNodeStatus): string {
    return STATUS_COLOR[status] ?? 'dim';
}

function connectorRow(text: string): VisualGraphRow {
    return { kind: 'connector', segments: [{ text }] };
}

function rowToLine(row: VisualGraphRow): string {
    const base = row.segments.map((segment) => segment.text).join('');
    // The active marker lives in the flat `lines` view only; the React consumer renders an
    // animated spinner off `row.isActive` instead of a static `*`.
    if (row.kind === 'node' && row.isActive) {
        return `${base} *`;
    }
    return base;
}

/**
 * Layered topological layout. Each node goes on its own row with a status glyph and a bracketed
 * `[status]` label; edges shown as vertical connectors with optional labels. Returns
 * `collapsed: true` when input exceeds `maxNodes` (caller falls back to the existing tree renderer
 * in that case). `rows` carries per-segment status so the React consumer can color the glyph and
 * the `[status]` group; `lines` is the flat join for plain renderers and tests.
 */
export function renderVisualGraph(input: VisualGraphInput): VisualGraphRender {
    const maxNodes = input.maxNodes ?? VISUAL_GRAPH_MAX_NODES;
    if (input.nodes.length > maxNodes) {
        return { rows: [], lines: [], collapsed: true };
    }
    if (input.nodes.length === 0) {
        const placeholder = '(no nodes)';
        return { rows: [connectorRow(placeholder)], lines: [placeholder], collapsed: false };
    }
    const width = input.maxWidth ?? VISUAL_GRAPH_DEFAULT_WIDTH;
    const rows: VisualGraphRow[] = [];
    const nodeIndex = new Map(input.nodes.map((node, index) => [node.nodeId, index]));

    input.nodes.forEach((node) => {
        const idWidth = Math.max(6, width - 20);
        const truncatedId = truncate(node.nodeId, idWidth);
        rows.push({
            kind: 'node',
            status: node.status,
            isActive: node.isActive,
            segments: [
                { text: STATUS_GLYPH[node.status] ?? '○', status: node.status },
                { text: ' ' },
                { text: truncatedId },
                { text: ' [', status: node.status },
                { text: node.status, status: node.status },
                { text: ']', status: node.status },
            ],
        });

        // Outgoing edges from this node — find children
        const outgoing = input.edges.filter((edge) => edge.from === node.nodeId);
        if (outgoing.length === 0) {
            return;
        }
        // Single-edge case: vertical connector
        if (outgoing.length === 1) {
            const edge = outgoing[0];
            if (edge === undefined) return;
            const childIndex = nodeIndex.get(edge.to);
            if (childIndex === undefined) return;
            const labelPart = edge.label !== undefined ? ` [${truncate(edge.label, 12)}]` : '';
            rows.push(connectorRow(`│${labelPart}`));
            rows.push(connectorRow('▼'));
            return;
        }
        // Multi-edge: list each child target
        outgoing.forEach((edge, edgeIdx) => {
            const childIndex = nodeIndex.get(edge.to);
            if (childIndex === undefined) return;
            const branchGlyph = edgeIdx === outgoing.length - 1 ? '└' : '├';
            const labelPart = edge.label !== undefined ? ` [${truncate(edge.label, 12)}]` : '';
            rows.push(connectorRow(`${branchGlyph}──► ${truncate(edge.to, 16)}${labelPart}`));
        });
    });

    const lines = rows.map(rowToLine);
    return { rows, lines, collapsed: false };
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}
