import type { BehaviorNode } from './behavior-node.js';

export type ActionGraphNode = BehaviorNode;

export type ActionGraphEdge = {
    readonly from: string;
    readonly to: string;
    readonly condition?: string;
};

export type ActionGraph = {
    readonly id: string;
    readonly nodes: readonly ActionGraphNode[];
    readonly edges: readonly ActionGraphEdge[];
};

export function createActionGraph(graph: ActionGraph): ActionGraph {
    if (graph.id.length === 0) {
        throw new Error('action graph id is required');
    }
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    if (nodeIds.size !== graph.nodes.length) {
        throw new Error('action graph node ids must be unique');
    }
    for (const edge of graph.edges) {
        if (!nodeIds.has(edge.from)) {
            throw new Error(`unknown action graph edge source: ${edge.from}`);
        }
        if (!nodeIds.has(edge.to)) {
            throw new Error(`unknown action graph edge target: ${edge.to}`);
        }
    }
    return {
        id: graph.id,
        nodes: graph.nodes.map((node) => ({ ...node })),
        edges: graph.edges.map((edge) => ({ ...edge })),
    };
}
