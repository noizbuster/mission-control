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
    GraphCheckpoint,
    ModelProviderSelection,
    ProtocolErrorCode,
} from '@mission-control/protocol';
import { ProtocolErrorCodeSchema } from '@mission-control/protocol';
import type { PricingTable } from '../behavior/budget/cost-ledger';
import type { NodeRunBudgetExtensionRequester } from '../behavior/budget/node-run-budget-extension';
import { type AbgGraphRunResult, runAbgGraph } from '../behavior/graph-runner';
import type { AbgNodeRegistry } from '../behavior/node-registry';
import type { LlmActorModel } from '../behavior/nodes/llm-actor/llm-actor-node';
import type { ProjectInstructionResource } from '../context/project-context-messages';
import type { SystemPromptEnvironment } from '../context/system-prompt';
import { createObservabilityRedactor, type ObservabilityRedactor } from '../providers/observability-redactor';
import type { ToolRegistry } from '../tools/tool-registry';
import { agentMessagesToSeedModelMessages } from './graph-coordinator-turn-messages';
import { findResumableRun } from './graph-resume-state';
import type { RunCoordinatorProviderTurnResult } from './run-coordinator-lifecycle';
import type { RunCoordinatorTurnContext, RunCoordinatorTurnRunner } from './run-coordinator-types';

export { agentMessagesToSeedModelMessages } from './graph-coordinator-turn-messages';

/**
 * Static graph wiring, closed over when the runner is built. The per-turn inputs (`initialMessages`
 * from admitted prompts, `abortSignal` from the drain's controller) are supplied by the turn
 * context, so this mirrors `AbgGraphRunnerInput` minus those two fields.
 */
export type GraphTurnRunnerWiring = {
    readonly graph: unknown;
    readonly sessionId: string;
    readonly sessionRunId?: string;
    readonly workflowName?: string;
    readonly now: () => string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly registry?: AbgNodeRegistry;
    readonly resolveSdkModel?: (options: AbgNodeModelOptions) => LlmActorModel;
    readonly toolRegistry?: ToolRegistry;
    readonly pricingTable?: PricingTable;
    readonly createToolCallId?: () => string;
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
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly requestNodeRunBudgetExtension?: NodeRunBudgetExtensionRequester;
    readonly nodeRunBudgetGrantSize?: number;
    readonly maxNodeRunBudgetExtensions?: number;
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
        const resumeCheckpoint = context.command === 'resume' ? await loadResumeCheckpoint(context) : undefined;
        const observabilityRedactor = wiring.observabilityRedactor ?? createObservabilityRedactor();
        const result = await runAbgGraph({
            ...graphRunnerInput,
            initialMessages,
            abortSignal: context.signal,
            observabilityRedactor,
            ...(approvalEvents.length > 0 ? { graphInput: { events: [...approvalEvents] } } : {}),
            ...(resumeCheckpoint !== undefined ? { resumeCheckpoint } : {}),
        });
        // Persist graph events with abort awareness. A long post-run flush of thousands of rows
        // previously kept the turn (and chat loop) uninterruptible for minutes after ESC/Ctrl+C.
        await flushGraphTurnEvents(context, result.events);
        // An aborted run is an interrupt regardless of how the graph settled (it may surface the
        // abort as `failed`). Mirror the flat path's abort-awareness so the drain maps this to
        // `run.interrupted` rather than `run.failed`.
        if (context.signal.aborted) {
            return { status: 'interrupted' };
        }
        return mapGraphTurnResult(result);
    };
}

async function loadResumeCheckpoint(
    context: Pick<RunCoordinatorTurnContext, 'readSessionEvents'>,
): Promise<GraphCheckpoint | undefined> {
    if (context.readSessionEvents === undefined) {
        return undefined;
    }
    return findResumableRun(await context.readSessionEvents())?.checkpoint;
}

/**
 * Flush graph-produced durable events. When the turn was aborted, only boundary/lifecycle events
 * that are needed for a coherent interrupted receipt are kept (skip pure log spam). Always check
 * abort between chunks so a backed-up write lane cannot trap the process after soft interrupt.
 */
export async function flushGraphTurnEvents(
    context: Pick<RunCoordinatorTurnContext, 'signal' | 'appendDurableEvent' | 'appendDurableEvents'>,
    events: readonly AgentEvent[],
): Promise<void> {
    const toFlush = context.signal.aborted ? events.filter(isInterruptFlushEvent) : events;
    if (toFlush.length === 0) {
        return;
    }
    if (context.appendDurableEvents !== undefined) {
        // Single-lane batch path: one queue entry, abort-checked inside the store when possible.
        const batchSignal = context.signal.aborted ? undefined : context.signal;
        await context.appendDurableEvents(toFlush, batchSignal);
        return;
    }
    for (const event of toFlush) {
        if (context.signal.aborted && !isInterruptFlushEvent(event)) {
            break;
        }
        await context.appendDurableEvent(event);
    }
}

/**
 * Events retained when flushing after abort. Keep lifecycle boundaries plus
 * canonical ABG emits: completed turns, proposed/settled tools, failures, and
 * blackboard/context state are bounded summaries needed by resume. Raw `log`
 * rows without `abg.emit` are observational noise and remain droppable.
 */
export function isInterruptFlushEvent(event: AgentEvent): boolean {
    return event.type !== 'log' || event.abg?.emit !== undefined;
}

/**
 * Map a terminal `AbgGraphRunResult` into the coordinator's turn-result shape. `completed` and
 * `cancelled` map directly. `failed`/`blocked` carry a best-effort reason from the graph's trailing
 * `graph.failed`/block events. When the graph surfaced a structured `terminalError` (e.g. a tool
 * failure with `code: "tool_failed"`), its code is validated against `ProtocolErrorCodeSchema` and
 * propagated — so a `tool_failed` settlement surfaces as `errorCode: 'tool_failed'` rather than the
 * generic `'unknown'`. Codes that are not in the protocol union (e.g. graph-internal
 * `graph_loop_limit`, `node_retry_exhausted`) fall back to `'unknown'`; the specific cause travels
 * in the `reason`. Non-terminal `created`/`active` should never surface as a turn result; if they
 * do it signals a wiring/runtime bug, so they map to `failed` rather than a silent empty success.
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
                reason: resolveFailedReason(result),
                errorCode: resolveProtocolErrorCode(result.terminalError?.code),
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

function lastEventMessage(events: readonly AgentEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const message = events[index]?.message;
        if (message !== undefined && message !== '') {
            return message;
        }
    }
    return undefined;
}

/**
 * Prefer the graph-level message (which `failGraph` already appends the terminalError cause to)
 * over the bare terminalError.message. Falls back to terminalError.message, then the generic
 * default when no graph-level event message exists.
 */
function resolveFailedReason(result: AbgGraphRunResult): string {
    const eventMessage = lastEventMessage(result.events);
    if (eventMessage !== undefined) {
        return eventMessage;
    }
    return result.terminalError?.message ?? 'graph run failed';
}

/**
 * Validate the graph's loose-string terminalError code against `ProtocolErrorCodeSchema`.
 * Graph-internal codes (`graph_loop_limit`, `node_retry_exhausted`) fall back to `'unknown'`;
 * tool/provider codes (`tool_failed`, `provider_aborted`) propagate.
 */
function resolveProtocolErrorCode(code: string | undefined): ProtocolErrorCode {
    if (code === undefined) {
        return 'unknown';
    }
    return ProtocolErrorCodeSchema.safeParse(code).success ? (code as ProtocolErrorCode) : 'unknown';
}
