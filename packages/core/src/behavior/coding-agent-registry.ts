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

import { type AbgNodeRegistry, createAbgNodeRegistry } from './node-registry';
import { createCompositeNodeRunners } from './nodes/composite-nodes';
import { runCriticNode } from './nodes/critic-node';
import { runDraftFrontmatterNode } from './nodes/draft-frontmatter-node';
import { runDualFixGateNode } from './nodes/dual-fix-gate-node';
import { runDualReviewRouteNode } from './nodes/dual-review-route-node';
import { runHumanApprovalNode } from './nodes/human-approval-node';
import { runIntentBridgeNode } from './nodes/intent-bridge-node';
import { runLlmActorNode } from './nodes/llm-actor/llm-actor-node-runner';
import { runMemoryNode } from './nodes/memory-node';
import { runMetisRejectGateNode } from './nodes/metis-reject-gate-node';
import { runModePolicyGateNode, runPolicyGateNode } from './nodes/policy-gate-node';
import { runResumeGateNode } from './nodes/resume-gate-node';
import { runSupervisorNode } from './nodes/supervisor-node';
import { runToolActorNode } from './nodes/tool-actor-node';

export function createCodingAgentNodeRegistry(): AbgNodeRegistry {
    const registry = createAbgNodeRegistry();
    registry.register('llm', runLlmActorNode);
    registry.register('tool', runToolActorNode);
    registry.register('memory', runMemoryNode);
    registry.register('policy', runPolicyGateNode);
    registry.register('mode-policy-gate', runModePolicyGateNode);
    registry.register('human-approval', runHumanApprovalNode);
    registry.register('critic', runCriticNode);
    registry.register('resume-gate', runResumeGateNode);
    registry.register('intent-bridge', runIntentBridgeNode);
    registry.register('draft-frontmatter', runDraftFrontmatterNode);
    registry.register('metis-reject-gate', runMetisRejectGateNode);
    registry.register('dual-review-route', runDualReviewRouteNode);
    registry.register('dual-fix-gate', runDualFixGateNode);
    registry.register('supervisor', runSupervisorNode);
    for (const [id, runner] of createCompositeNodeRunners()) {
        registry.register(id, runner);
    }
    return registry;
}
