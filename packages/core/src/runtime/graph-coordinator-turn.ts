/**
 * Graph turn runner for `SessionRunCoordinator`. This is the engine-agnostic turn runner that lets
 * the session queue/steer/resume machinery drive the ABG coding-agent graph instead of the flat
 * provider tool loop. The coordinator promotes one admitted input per drain turn and hands this
 * runner the promoted conversation; the runner seeds a fresh graph run, persists the graph's
 * `AgentEvent`s through the same durability sink the flat path uses, and reports the graph's
 * terminal status in the shared `RunCoordinatorProviderTurnResult` shape so `drainCoordinatorRun`'s
 * promotion/finalize logic is reused unchanged.
 *
 * Relationship to `runCodingPromptOnGraph` (the CLI `--engine graph` seam): that helper assembles
 * the wiring (graph + registry + resolveSdkModel + toolRegistry) and runs one prompt through the
 * runtime. This adapter takes the SAME pre-assembled wiring but exposes it as a turn runner so the
 * coordinator owns queue/steer/resume around it.
 */
import type {
    AbgEmbeddedEvent,
    AbgNodeModelOptions,
    AgentEvent,
    AgentMessage,
    ModelProviderSelection,
} from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { PricingTable } from '../behavior/budget/cost-ledger.js';
import { type AbgGraphRunResult, runAbgGraph } from '../behavior/graph-runner.js';
import type { AbgNodeRegistry } from '../behavior/node-registry.js';
import type { LlmActorModel } from '../behavior/nodes/llm-actor/llm-actor-node.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { RunCoordinatorProviderTurnResult } from './run-coordinator-lifecycle.js';
import type { RunCoordinatorTurnRunner } from './run-coordinator-types.js';

/**
 * Static graph wiring, closed over when the runner is built. The per-turn inputs (`initialMessages`
 * from admitted prompts, `abortSignal` from the drain's controller) are supplied by the turn
 * context, so this mirrors `AbgGraphRunnerInput` minus those two fields.
 */
export type GraphTurnRunnerWiring = {
    readonly graph: unknown;
    readonly sessionId: string;
    readonly now: () => string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly registry?: AbgNodeRegistry;
    readonly resolveSdkModel?: (options: AbgNodeModelOptions) => LlmActorModel;
    readonly toolRegistry?: ToolRegistry;
    readonly pricingTable?: PricingTable;
    /**
     * Reads approval decisions to thread into the graph's `graphInput.events`, so a graph that
     * blocked on a `human-approval` node (or a `requires_approval` policy) RESUMES on a promoted
     * turn instead of re-blocking. Returns `approval.updated` embedded events keyed by approvalId
     * (the approvalId a blocked run surfaces via its `approval.requested` event). This is the entry
     * point an approval broker drives: it owns the decision SOURCE (interactive prompt, persisted
     * decision, etc.); the turn runner owns the THREADING. Omitted, or empty on a given turn, → the
     * graph blocks exactly as before (the pre-existing behavior). Called once per promoted turn so
     * a broker can return `[]` on the first run and the decision on a resumed run.
     */
    readonly readApprovalDecisions?: () => Promise<readonly AbgEmbeddedEvent[]>;
};

/**
 * Build a `RunCoordinatorTurnRunner` that drives `runAbgGraph`. Each promoted input seeds a fresh
 * graph run from the admitted conversation; the graph's events are persisted through the
 * coordinator's durable sink, then the terminal status is mapped into the shared result shape.
 */
export function createGraphTurnRunner(wiring: GraphTurnRunnerWiring): RunCoordinatorTurnRunner {
    return async (context) => {
        const initialMessages = agentMessagesToSeedModelMessages(await context.readMessages());
        // Thread approval decisions into graphInput.events so a graph that blocked on a
        // human-approval node / requires_approval policy RESUMES on a promoted turn (the gate's
        // observedApproval(graphInput?.events) sees the decision). The non-graph fields on the
        // wiring (readApprovalDecisions) are peeled off so only AbgGraphRunnerInput fields are
        // forwarded. Empty/absent decisions → no graphInput → the graph blocks as before.
        const { readApprovalDecisions, ...graphRunnerInput } = wiring;
        const approvalEvents = readApprovalDecisions !== undefined ? await readApprovalDecisions() : [];
        const result = await runAbgGraph({
            ...graphRunnerInput,
            initialMessages,
            abortSignal: context.signal,
            ...(approvalEvents.length > 0 ? { graphInput: { events: [...approvalEvents] } } : {}),
        });
        for (const event of result.events) {
            await context.appendDurableEvent(event);
        }
        // An aborted run is an interrupt regardless of how the graph settled (it may surface the
        // abort as `failed`). Mirror the flat path's abort-awareness so the drain maps this to
        // `run.interrupted` rather than `run.failed`.
        if (context.signal.aborted) {
            return { status: 'interrupted' };
        }
        return mapGraphTurnResult(result);
    };
}

/**
 * Map a terminal `AbgGraphRunResult` into the coordinator's turn-result shape. `completed` and
 * `cancelled` map directly. `failed`/`blocked` carry a best-effort reason from the graph's trailing
 * `graph.failed`/block events; the coordinator-level `errorCode` is `unknown` because the graph's
 * own codes (`graph_loop_limit`, `node_retry_exhausted`, ...) are not `ProtocolErrorCode` values —
 * the specific cause travels in the `reason`. Non-terminal `created`/`active` should never surface
 * as a turn result; if they do it signals a wiring/runtime bug, so they map to `failed` rather than
 * a silent empty success.
 */
export function mapGraphTurnResult(result: AbgGraphRunResult): RunCoordinatorProviderTurnResult {
    switch (result.status) {
        case 'completed':
            return { status: 'completed' };
        case 'cancelled':
            return { status: 'interrupted' };
        case 'failed':
            // A provider abort (`provider_aborted`) is an interrupt, not a hard failure — mirror the
            // flat run coordinator's abort-awareness (run-coordinator-provider-turn.ts) so the drain
            // maps it to `run.interrupted`. The code travels on the result's `terminalError` (a node
            // surfaced a structured provider error); failures with no recognizable code stay `failed`.
            if (result.terminalError !== undefined && result.terminalError.code === 'provider_aborted') {
                return { status: 'interrupted' };
            }
            return {
                status: 'failed',
                reason: lastEventMessage(result.events) ?? 'graph run failed',
                errorCode: 'unknown',
            };
        case 'blocked':
            // A graph `blocked` settle is a node-level hold (policy/approval/etc.), not necessarily
            // a tool failure, so the errorCode stays generic; the blocking context is in the reason.
            return {
                status: 'blocked_on_approval',
                reason: lastEventMessage(result.events) ?? 'graph run blocked waiting for input',
                errorCode: 'unknown',
            };
        case 'created':
        case 'active':
            return {
                status: 'failed',
                reason: `graph settled non-terminally as ${result.status}`,
                errorCode: 'unknown',
            };
    }
}

/**
 * Seed the graph's Blackboard from the admitted conversation. `modelVisibleMessages` from the
 * session admission projection is always `role: 'user'` prompts; system/assistant text roles are
 * mapped too for completeness. `tool` results are not seedable without a tool-name lookup and are
 * skipped — the graph regenerates its own tool turns from the seeded context.
 */
export function agentMessagesToSeedModelMessages(messages: readonly AgentMessage[]): ModelMessage[] {
    const seed: ModelMessage[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            seed.push({ role: 'system', content: message.content });
        } else if (message.role === 'user') {
            seed.push({ role: 'user', content: message.content });
        } else if (message.role === 'assistant') {
            seed.push({ role: 'assistant', content: message.content });
        }
    }
    return seed;
}

function lastEventMessage(events: readonly AgentEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const message = events[index]?.message;
        if (message !== undefined && message !== '') {
            return message;
        }
    }
    return undefined;
}
