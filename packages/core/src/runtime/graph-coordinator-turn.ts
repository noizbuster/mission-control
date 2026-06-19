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
    AbgSignal,
    AgentEvent,
    AgentMessage,
    ModelProviderSelection,
} from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ProjectInstructionResource } from '../context/project-context-messages.js';
import type { SystemPromptEnvironment } from '../context/system-prompt.js';
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
     * Fail the run on the first non-approval tool settlement failure instead of surfacing it to the
     * model — parity with the flat run coordinator's `haltOnFailedToolSettlement`. Flows into
     * `runAbgGraph` with the rest of the wiring. Set by the owner/headless graph path so a denied /
     * non-allowlisted command terminates immediately rather than looping until the node-run budget.
     */
    readonly haltOnFailedToolSettlement?: boolean;
    /**
     * Serialize a proposed tool BATCH (interactive graph path): forwarded to `runAbgGraph` so the
     * tool bridge wraps each tool's `execute` in a shared mutex — at most one approval is pending at
     * a time, matching the flat path's sequential cadence and the broker's single-pending invariant.
     * Omitted on the non-interactive path (parallel tool batches).
     */
    readonly serializeToolExecution?: boolean;
    /**
     * Observation-only tap forwarded into `runAbgGraph` (`AbgGraphRunnerInput.onSignal`); fires for
     * every node signal before projection — including `llm.text.delta` streaming deltas. Lets the
     * interactive owner render live token deltas. Awaited between signals (see `AbgGraphRunnerInput`),
     * so an async tap such as a tool-arg preview render completes in order. Does not affect projection,
     * persistence, or the run result.
     */
    readonly onSignal?: (signal: AbgSignal) => void | Promise<void>;
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
    /**
     * Forwarded to `AbgGraphRunnerInput.systemPromptEnv` so `LLMActor` includes a `# Environment`
     * section in the system prompt. Built by the caller from process state.
     */
    readonly systemPromptEnv?: SystemPromptEnvironment;
    /**
     * Forwarded to `AbgGraphRunnerInput.projectInstructionResources` so `LLMActor` appends trusted
     * AGENTS.md/CLAUDE.md instructions to the system prompt as reference data. The caller owns
     * trust-aware discovery (see `loadProjectResources`).
     */
    readonly projectInstructionResources?: readonly ProjectInstructionResource[];
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
            // prior flat run coordinator's abort-awareness so the drain
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
            // A graph `blocked` settle is an approval hold (currently only the LLMActor
            // `approval_required` short-circuit). The result carries the blocking toolCallId + reason
            // so the drain surfaces a resumable `run.blocked` with the toolCallId — parity with the
            // flat run coordinator. The errorCode stays generic (the graph's own codes are not
            // `ProtocolErrorCode` values); the approvalId travels on the gate's emitted
            // approval.requested/approval.blocked events.
            return {
                status: 'blocked_on_approval',
                reason: result.reason ?? lastEventMessage(result.events) ?? 'graph run blocked waiting for input',
                errorCode: 'unknown',
                ...(result.toolCallId !== undefined ? { toolCallId: result.toolCallId } : {}),
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
 * mapped too for completeness. `tool` results are also mapped: the `toolName` is recovered from a
 * preceding assistant message's `providerToolCalls` (matched by `toolCallId`) because the AI-SDK
 * tool-result shape requires it. Tool results without a matching prior proposal are skipped (the
 * SDK would reject a tool-result part with no `toolName`).
 */
export function agentMessagesToSeedModelMessages(messages: readonly AgentMessage[]): ModelMessage[] {
    const toolNameByCallId = new Map<string, string>();
    for (const message of messages) {
        if (message.role === 'assistant') {
            for (const call of message.providerToolCalls ?? []) {
                toolNameByCallId.set(call.toolCallId, call.toolName);
            }
        }
    }
    const seed: ModelMessage[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            seed.push({ role: 'system', content: message.content });
        } else if (message.role === 'user') {
            seed.push({ role: 'user', content: message.content });
        } else if (message.role === 'assistant') {
            seed.push({ role: 'assistant', content: message.content });
        } else if (message.role === 'tool') {
            const toolName = toolNameByCallId.get(message.toolCallId);
            if (toolName === undefined) {
                continue;
            }
            seed.push({
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: message.toolCallId,
                        toolName,
                        output: toolResultOutputFor(message),
                    },
                ],
            });
        }
    }
    return seed;
}

function toolResultOutputFor(message: Extract<AgentMessage, { readonly role: 'tool' }>):
    | { readonly type: 'text'; readonly value: string }
    | { readonly type: 'error-text'; readonly value: string } {
    if (message.status === 'failed') {
        const error = message.error;
        return { type: 'error-text', value: error?.message ?? 'tool failed' };
    }
    return { type: 'text', value: message.output ?? '' };
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
