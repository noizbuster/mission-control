/**
 * The coding-agent graph: the Observe → Decide → Act loop expressed as ABG nodes/edges
 * over the coordinator (ABG §5.1, D1).
 *
 * Structure (minimal, correct, Phase-1):
 *   entry ─▶ [llm-actor] ──self-edge (rule `llm-loop-active`)──▶ [llm-actor] ─▶ … ─▶ done
 *
 * - `llm-actor` (kind 'llm' → `runLlmActorNode`) reads the running conversation from the
 *   Blackboard, builds the AI-SDK tool set from the ToolRegistry via the §5.2 bridge,
 *   runs exactly one `streamText` step (`stopWhen: stepCountIs(1)`), then appends the
 *   response messages (assistant turn + tool results) back onto the Blackboard and sets
 *   `llm.loop_active`.
 * - The self-edge is gated by `blackboard.value.equals { 'llm.loop_active', true }`: while
 *   the model proposes tool calls the loop re-enters `llm-actor`; when the model emits a
 *   final answer (no tool calls) the flag is false, the edge does not fire, and the graph
 *   completes. So the GRAPH owns the loop — every tool turn is a graph transition (§10.3),
 *   never the SDK's internal multi-step machinery.
 *
 * The tool-turn budget is `maxNodeRuns`, pinned to 40 for this graph (the coordinator's
 * own default of 48 applies only to graphs that omit `defaults.maxNodeRuns`). It replaces
 * the flat-loop `DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT`. Phase 2 adds ContextPacker/compaction in
 * front of `llm-actor`; Phase 3 cuts the CLI over to this graph; Phase 6 adds a Critic/
 * supervisor around it. This is the Phase-1 core that already runs a real agent.
 */
import type { AbgGraphSpec, AbgNodeModelOptions } from '@mission-control/protocol';

export const CODING_AGENT_GRAPH_ID = 'coding-agent';
export const DEFAULT_CODING_AGENT_MAX_NODE_RUNS = 40;

export type CodingAgentGraphOptions = {
    /** Provider/model the LLMActor resolves to an SDK model via the runner's `resolveSdkModel`. */
    readonly model: AbgNodeModelOptions;
    /** Tool-turn budget (graph loop bound). Default 40. */
    readonly maxNodeRuns?: number;
};

export function createCodingAgentGraph(options: CodingAgentGraphOptions): AbgGraphSpec {
    return {
        id: CODING_AGENT_GRAPH_ID,
        version: '0.1.0',
        entryNodeId: 'llm-actor',
        defaults: {
            model: options.model,
            maxNodeRuns: options.maxNodeRuns ?? DEFAULT_CODING_AGENT_MAX_NODE_RUNS,
        },
        nodes: [
            {
                id: 'llm-actor',
                kind: 'llm',
                label: 'Coding agent — observe → decide → act',
            },
        ],
        edges: [
            {
                source: 'llm-actor',
                target: 'llm-actor',
                condition: 'llm-loop-active',
                priority: 10,
            },
        ],
        rules: [
            {
                id: 'llm-loop-active',
                description: 're-enter the LLM actor while it keeps proposing tool calls',
                when: {
                    kind: 'blackboard.value.equals',
                    key: 'llm.loop_active',
                    value: true,
                },
            },
        ],
        policies: [],
    };
}
