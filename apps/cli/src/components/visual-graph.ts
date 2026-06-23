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

export type VisualGraphRender = {
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

/**
 * Layered topological layout. Each node goes on its own row; edges shown as vertical connectors
 * with optional labels. Returns `collapsed: true` when input exceeds `maxNodes` (caller falls back
 * to the existing tree renderer in that case).
 */
export function renderVisualGraph(input: VisualGraphInput): VisualGraphRender {
    const maxNodes = input.maxNodes ?? VISUAL_GRAPH_MAX_NODES;
    if (input.nodes.length > maxNodes) {
        return { lines: [], collapsed: true };
    }
    if (input.nodes.length === 0) {
        return { lines: ['(no nodes)'], collapsed: false };
    }
    const width = input.maxWidth ?? VISUAL_GRAPH_DEFAULT_WIDTH;
    const lines: string[] = [];
    const nodeIndex = new Map(input.nodes.map((node, index) => [node.nodeId, index]));

    input.nodes.forEach((node, index) => {
        const glyph = STATUS_GLYPH[node.status] ?? '○';
        const truncatedId = truncate(node.nodeId, Math.max(8, width - 18));
        const active = node.isActive ? ' *' : '';
        lines.push(`${glyph} ${truncatedId}${active}`);

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
            lines.push(`│${labelPart}`);
            lines.push('▼');
            return;
        }
        // Multi-edge: list each child target
        outgoing.forEach((edge, edgeIdx) => {
            const childIndex = nodeIndex.get(edge.to);
            if (childIndex === undefined) return;
            const branchGlyph = edgeIdx === outgoing.length - 1 ? '└' : '├';
            const labelPart = edge.label !== undefined ? ` [${truncate(edge.label, 12)}]` : '';
            lines.push(`${branchGlyph}──► ${truncate(edge.to, 16)}${labelPart}`);
        });
    });

    return { lines, collapsed: false };
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}
