import type {
    AbgGraphInput,
    AbgGraphStatus,
    AbgNodeModelOptions,
    AgentEvent,
    ModelProviderSelection,
} from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { PricingTable } from './budget/cost-ledger.js';
import { runBoundedAbgGraph } from './graph-coordinator.js';
import type { AbgNodeRegistry } from './node-registry.js';
import type { LlmActorModel } from './nodes/llm-actor/llm-actor-node.js';

export type AbgGraphRunnerInput = {
    readonly graph: unknown;
    readonly graphInput?: AbgGraphInput;
    readonly sessionId: string;
    readonly now: () => string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly registry?: AbgNodeRegistry;
    readonly maxNodeRuns?: number;
    readonly graphNodeConcurrency?: number;
    readonly providerToolCallConcurrency?: number;
    readonly shellConcurrency?: number;
    /**
     * Real tool surface. When provided, `ToolActor` nodes resolve + invoke tools through
     * it; otherwise the coding-agent graph cannot perform real work.
     */
    readonly toolRegistry?: ToolRegistry;
    /**
     * Abort/interrupt signal from the run owner, threaded into `AbgNodeRunContext.abortSignal`
     * so cancellable nodes honor it.
     */
    readonly abortSignal?: AbortSignal;
    /**
     * Seed conversation for the Blackboard message list (typically the user turn). The
     * Observe→Decide→Act loop appends to this across re-entries.
     */
    readonly initialMessages?: readonly ModelMessage[];
    /**
     * Resolves an `AbgNodeModelOptions` (provider/model ids) into a Vercel AI SDK model
     * instance for `LLMActor`. Phase 5 wires the real provider registry; Phase 1 injects
     * a scripted/mock resolver in the integration test. When absent, `LLMActor` cannot run.
     */
    readonly resolveSdkModel?: (options: AbgNodeModelOptions) => LlmActorModel;
    /**
     * Operator-supplied token pricing (cents per million tokens) for the `usage →
     * `policy.budget.*` cost events. Combined with the graph's `budgetCents` to build the
     * per-run `CostLedger`. Empty/absent → no cost accrues (the ceiling still runs but
     * never trips on its own). List prices drift, so no defaults are shipped.
     */
    readonly pricingTable?: PricingTable;
};

export type AbgGraphRunResult = {
    readonly graphId: string;
    readonly status: AbgGraphStatus;
    readonly events: readonly AgentEvent[];
    /**
     * The Blackboard's final message list on a `completed` run (omitted on failed/blocked).
     * Lets callers (e.g. the `task` subagent spawner) read the graph's final assistant output
     * without re-deriving it from projected events (emit payloads are not carried into AgentEvents).
     */
    readonly finalMessages?: readonly ModelMessage[];
};

export async function runAbgGraph(input: AbgGraphRunnerInput): Promise<AbgGraphRunResult> {
    return runBoundedAbgGraph(input);
}
