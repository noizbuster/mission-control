/**
 * Agent-based model resolution for workflow graphs.
 *
 * Graph nodes and graph defaults may declare an `agent` reference instead of a
 * concrete `model: { providerID, modelID }`. At materialization time (inside
 * `createAuthorableAbgGraph`, after schema validation and before deep-freeze),
 * `resolveGraphAgentModels` looks up each agent name through the injected
 * `AgentModelLookup` and copies the resolved model into the node/defaults —
 * but ONLY when no explicit `model` is already set (explicit per-node model
 * wins over agent-referenced model).
 *
 * The lookup function is built by the CLI from the discovered `AgentIndex`
 * (`packages/core/src/agents/agent-loader.ts`). The behavior package stays
 * decoupled from the agent system: it only sees the lookup function, not the
 * `AgentIndex` itself (avoids a circular dependency agents → behavior → agents).
 */
import type { AbgGraphSpec, AbgNodeModelOptions } from '@mission-control/protocol';

export type AgentModelLookup = (agentName: string) => AbgNodeModelOptions | undefined;

export function resolveGraphAgentModels(graph: AbgGraphSpec, lookup: AgentModelLookup): AbgGraphSpec {
    const defaultsAgent = graph.defaults?.agent;
    const defaultsModelMissing = graph.defaults?.model === undefined;
    const resolveDefaults = defaultsAgent !== undefined && defaultsModelMissing;

    const nodesToResolve = graph.nodes.filter((node) => node.agent !== undefined && node.model === undefined);

    if (!resolveDefaults && nodesToResolve.length === 0) {
        return graph;
    }

    let defaults = graph.defaults;
    if (resolveDefaults && defaultsAgent !== undefined) {
        const model = lookup(defaultsAgent);
        if (model !== undefined) {
            defaults = { ...graph.defaults, model };
        }
    }

    let nodes = graph.nodes;
    if (nodesToResolve.length > 0) {
        nodes = graph.nodes.map((node) => {
            if (node.agent !== undefined && node.model === undefined) {
                const model = lookup(node.agent);
                if (model !== undefined) {
                    return { ...node, model };
                }
            }
            return node;
        });
    }

    return { ...graph, defaults, nodes };
}
