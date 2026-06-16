/**
 * Node registry for the coding-agent graph: the REAL Phase-1 leaf runners (LLMActor,
 * ToolActor, Memory, PolicyGate, HumanApproval) plus the composite nodes, registered
 * under their plain kinds.
 *
 * This is deliberately a SEPARATE registry from `createDefaultAbgNodeRegistry` (which
 * still serves the mock-based fixtures and the not-yet-cut-over flat loop — strangler
 * fig). The coding-agent graph (and, after Phase 3, the CLI) runs against THIS registry
 * so its `llm` / `tool` / `memory` / `policy` / `human-approval` nodes resolve to the
 * real implementations, while existing mock-driven tests are untouched.
 */

import { type AbgNodeRegistry, createAbgNodeRegistry } from './node-registry.js';
import { createCompositeNodeRunners } from './nodes/composite-nodes.js';
import { runCriticNode } from './nodes/critic-node.js';
import { runHumanApprovalNode } from './nodes/human-approval-node.js';
import { runLlmActorNode } from './nodes/llm-actor/llm-actor-node-runner.js';
import { runMemoryNode } from './nodes/memory-node.js';
import { runPolicyGateNode } from './nodes/policy-gate-node.js';
import { runToolActorNode } from './nodes/tool-actor-node.js';

export function createCodingAgentNodeRegistry(): AbgNodeRegistry {
    const registry = createAbgNodeRegistry();
    registry.register('llm', runLlmActorNode);
    registry.register('tool', runToolActorNode);
    registry.register('memory', runMemoryNode);
    registry.register('policy', runPolicyGateNode);
    registry.register('human-approval', runHumanApprovalNode);
    registry.register('critic', runCriticNode);
    for (const [id, runner] of createCompositeNodeRunners()) {
        registry.register(id, runner);
    }
    return registry;
}
