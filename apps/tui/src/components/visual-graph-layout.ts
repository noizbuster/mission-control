import type { GraphLabel, NodeLabel } from '@dagrejs/dagre';
import { graphlib, layout } from '@dagrejs/dagre';
import type { AbgNodeStatus } from '@mission-control/protocol';
import type { VisualGraphInput } from './visual-graph-types';

export const NODE_CONTENT_WIDTH = 20;
export const NODE_BOX_WIDTH = NODE_CONTENT_WIDTH + 2;
export const NODE_BOX_HEIGHT = 3;

export type NodePosition = {
    readonly id: string;
    readonly cellX: number;
    readonly cellY: number;
    readonly status: AbgNodeStatus;
    readonly isActive: boolean;
};

export function layoutGraph(input: VisualGraphInput): {
    readonly positions: Map<string, NodePosition>;
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
    const placedTargetsBySource = new Map<string, Set<string>>();
    for (const edge of input.edges) {
        if (edge.from === edge.to) {
            selfLoops.add(edge.from);
            continue;
        }
        if (!known.has(edge.from) || !known.has(edge.to)) continue;
        const placedTargets = placedTargetsBySource.get(edge.from);
        if (placedTargets?.has(edge.to)) continue;
        if (placedTargets === undefined) {
            placedTargetsBySource.set(edge.from, new Set([edge.to]));
        } else {
            placedTargets.add(edge.to);
        }
        graph.setEdge(edge.from, edge.to);
    }

    layout(graph);

    const positions = new Map<string, NodePosition>();
    const nodeById = new Map(input.nodes.map((node) => [node.nodeId, node]));
    for (const id of graph.nodes()) {
        const label = graph.node(id);
        const original = nodeById.get(id);
        if (label === undefined || original === undefined || label.x === undefined || label.y === undefined) continue;
        positions.set(id, {
            id,
            cellX: Math.round(label.x - NODE_BOX_WIDTH / 2),
            cellY: Math.round(label.y - NODE_BOX_HEIGHT / 2),
            status: original.status,
            isActive: original.isActive,
        });
    }
    return { positions, selfLoops };
}
