import type {
    AbgGraphInput,
    AbgGraphStatus,
    AbgNodeModelOptions,
    AbgSignal,
    AgentEvent,
    ModelProviderSelection,
} from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ProjectInstructionResource } from '../context/project-context-messages.js';
import type { SystemPromptEnvironment } from '../context/system-prompt.js';
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
    /**
     * Fail the run on the FIRST non-approval tool settlement failure (a `command_not_allowed`,
     * a hard registry error, ...) instead of surfacing it to the model — parity with the flat run
     * coordinator's `haltOnFailedToolSettlement`. Surfacing an unfixable error (e.g. a
     * non-allowlisted command) would otherwise make the model retry the same call until the
     * node-run budget is exhausted. Set by the owner/headless wiring; off for paths that want the
     * model to self-correct on retryable-looking tool errors.
     */
    readonly haltOnFailedToolSettlement?: boolean;
    /**
     * Serialize a proposed tool BATCH so at most one tool executes at a time within a turn — the
     * INTERACTIVE graph path needs this because the interactive approval broker allows a single
     * pending approval (a second concurrent approval in a batch would auto-deny). Forwarded to the
     * tool bridge via `AbgNodeRunContext`. Omitted on the non-interactive path so tool batches stay
     * parallel.
     */
    readonly serializeToolExecution?: boolean;
    /**
     * Observation-only tap invoked for every node signal yielded during the run, BEFORE projection to
     * an AgentEvent — including high-frequency streaming signals (`llm.text.delta`,
     * `llm.reasoning.delta`) that are NOT persisted. Lets an interactive caller render live token
     * deltas without bloating the durable ledger. Pure side-effect: does not influence projection,
     * persistence, or the run result. Omitted by the flat path and the non-interactive graph path.
     * Awaited between signals: a tap returning a Promise (e.g. an async tool-arg preview render on the
     * interactive path) completes before the next signal is observed, preserving TUI output order.
     * Awaiting a `void` return (sync taps such as delta rendering) is a no-op microtask, so streaming
     * throughput is unaffected.
     */
    readonly onSignal?: (signal: AbgSignal) => void | Promise<void>;
    /**
     * Environment block threaded into `AbgNodeRunContext.systemPromptEnv` so `LLMActor` can include
     * a `# Environment` section in the system prompt (cwd, workspaceRoot, git, platform, date).
     * Without this the model has no workspace awareness. Built by the caller (CLI/desktop) from
     * process state; the graph never reads process state itself.
     */
    readonly systemPromptEnv?: SystemPromptEnvironment;
    /**
     * Trusted project instruction resources (AGENTS.md / CLAUDE.md) threaded into
     * `AbgNodeRunContext.projectInstructionResources` so `LLMActor` can append them to the system
     * prompt as reference data. The graph never loads these itself; the caller owns trust-aware
     * discovery (see `loadProjectResources`).
     */
    readonly projectInstructionResources?: readonly ProjectInstructionResource[];
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
    /**
     * On a `failed` run, the structured provider error that terminated the run (when a node surfaced
     * one — e.g. the flat-bridge `FlatProviderBridgeError`). Carries the `code` so downstream mapping
     * can distinguish an abort (`provider_aborted`) from a hard failure the way the flat run
     * coordinator does. Omitted when the failure had no recognizable code (the common case). The code
     * is a loose string (not `ProtocolErrorCode`) because it is read from a provider-shaped `unknown`
     * without a runtime union check; consumers compare it literally.
     */
    readonly terminalError?: AbgGraphTerminalError;
    /**
     * On a `blocked` run (a tool settled `approval_required`), the tool call id and reason that
     * identify the pending approval. The turn-runner mapping threads these into the
     * `blocked_on_approval` result so the run surfaces as resumable with the toolCallId — parity
     * with the flat run coordinator. Omitted on non-blocked runs (and on a blocked run with no
     * recognizable approval context).
     */
    readonly toolCallId?: string;
    readonly reason?: string;
};

/**
 * Structured provider error surfaced on a failed `AbgGraphRunResult`. A loose-shaped mirror of
 * `ProtocolError` so the graph result can carry a provider error code without claiming the code has
 * been validated against the `ProtocolErrorCode` union.
 */
export type AbgGraphTerminalError = {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
};

export async function runAbgGraph(input: AbgGraphRunnerInput): Promise<AbgGraphRunResult> {
    return runBoundedAbgGraph(input);
}
