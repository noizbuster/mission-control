import type {
    AbgEmitMetadata,
    AbgNodeKind,
    AbgNodeModelOptions,
    AbgSignal,
    AgentEvent,
} from '@mission-control/protocol';
import { AgentEventTypeSchema } from '@mission-control/protocol';

export type AbgSignalProjectionInput = {
    readonly graphId: string;
    readonly sessionId: string;
    readonly timestamp: string;
    readonly signal: AbgSignal;
    readonly causationId?: string;
    readonly correlationId?: string;
    readonly nodeKind?: AbgNodeKind;
    readonly model?: AbgNodeModelOptions;
    readonly attempt?: number;
    readonly maxAttempts?: number;
};

/**
 * Emit-event types whose payload is persisted on the durable `AgentEvent.abg.emit`. These are the
 * turn/tool lifecycle boundaries the coding-step replay projects into `codingSteps` (final text,
 * proposed tool calls, tool outcomes, node errors). High-frequency streaming emits
 * (`llm.text.delta`, `llm.reasoning.delta`, ...) are NOT listed — their per-token payloads would
 * bloat the JSONL ledger, and the projection does not need them (the boundary events summarize the
 * turn). The structured `emit.type` is persisted ONLY for these boundary types; other emits stay
 * as `log` events with their type encoded in the message string (unchanged).
 */
const EMIT_TYPES_WITH_PERSISTED_PAYLOAD: ReadonlySet<string> = new Set([
    'llm.turn.completed',
    'llm.tool_call.proposed',
    'tool.completed',
    'tool.failed',
    'llm.error',
    // v2: persisted so the overlay Cost&Policy pane can read `cents`, `budgetCents`,
    // and token totals off `event.abg.emit.payload` instead of staying at $0.00.
    'policy.budget.accumulated',
    'policy.budget.warning',
    'policy.budget.exceeded',
    // v2: persisted so the overlay Blackboard tab can show key/value deltas as
    // first-class events with structured payloads (not just log strings).
    'blackboard.set',
    'blackboard.delete',
]);

export function projectAbgSignalToEvent(input: AbgSignalProjectionInput): AgentEvent {
    return {
        type: eventTypeForSignal(input.signal),
        timestamp: input.timestamp,
        durability: 'durable',
        sessionId: input.sessionId,
        message: messageForSignal(input.signal),
        abg: {
            graphId: input.graphId,
            nodeId: input.signal.nodeId,
            ...(input.nodeKind !== undefined ? { nodeKind: input.nodeKind } : {}),
            signalType: input.signal.type,
            ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
            ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
            ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
            ...(emitMetadataForSignal(input.signal) ?? {}),
        },
        ...(toolResultForEmit(input.signal) ?? {}),
        ...(modelProviderSelection(input.model) ?? {}),
    };
}

/**
 * Carry a boundary emit's structured type + payload into `abg.emit` so the durable ledger is the
 * single source of truth for what a graph node emitted. Returns `undefined` for non-emit signals
 * and for emit signals outside the persisted-payload allowlist (those keep their pre-existing
 * `log` representation only — no ledger growth).
 */
function emitMetadataForSignal(signal: AbgSignal): { readonly emit: AbgEmitMetadata } | undefined {
    if (signal.type !== 'emit' || !EMIT_TYPES_WITH_PERSISTED_PAYLOAD.has(signal.event.type)) {
        return undefined;
    }
    return {
        emit: {
            type: signal.event.type,
            ...(signal.event.payload !== undefined ? { payload: signal.event.payload } : {}),
        },
    };
}

/**
 * Synthesize `event.toolResult` for a graph tool-lifecycle emit (tool.completed/tool.failed from
 * the LLMActor adapter) so the toolCallId travels as a first-class field — exactly like the flat
 * run loop's tool events, which set `toolResult`. The graph's adapter emits carry the toolCallId
 * only in `abg.emit.payload`; without this, downstream projections keyed on `event.toolResult`
 * (the JSON renderer's `toolState.toolCallId`, session-replay tool outcomes) never see it, so a
 * graph run's `session.stopped`/replay misses the toolCallId a flat run surfaces. Payload is
 * `unknown`; narrowed with `in`/`typeof` — no cast. Returns `undefined` for non-tool emits or
 * payloads without a string toolCallId.
 */
function toolResultForEmit(signal: AbgSignal):
    | {
          readonly toolResult: { readonly toolCallId: string; readonly status: 'completed' | 'failed' };
          readonly taskId: string;
      }
    | undefined {
    if (signal.type !== 'emit') {
        return undefined;
    }
    const eventType = signal.event.type;
    if (eventType !== 'tool.completed' && eventType !== 'tool.failed') {
        return undefined;
    }
    const payload = signal.event.payload;
    if (typeof payload !== 'object' || payload === null || !('toolCallId' in payload)) {
        return undefined;
    }
    const toolCallId = payload.toolCallId;
    if (typeof toolCallId !== 'string') {
        return undefined;
    }
    // `taskId` mirrors the flat run loop's tool events (which set `taskId` to the toolCallId) so a
    // graph run's `tool.completed`/`tool.failed` events are observable on the SAME field downstream
    // (engine-agnostic assertions, session replay) — not only on `toolResult.toolCallId`.
    return {
        toolResult: { toolCallId, status: eventType === 'tool.completed' ? 'completed' : 'failed' },
        taskId: toolCallId,
    };
}

function eventTypeForSignal(signal: AbgSignal): AgentEvent['type'] {
    switch (signal.type) {
        case 'started':
            return 'node.started';
        case 'progress':
        case 'spawn':
        case 'fallback':
            return 'node.progress';
        case 'emit': {
            // An emit signal whose event.type is itself a first-class AgentEvent type (e.g.
            // tool.completed, tool.failed from the LLMActor adapter) projects to that type so the
            // graph's tool-lifecycle events are observable exactly like the flat loop's (which emit
            // them directly). ABG-internal emit types (llm.text.delta, llm.turn.completed,
            // context.packed, ...) are NOT AgentEvent types and stay 'log' — their structured type
            // + payload travel in abg.emit for the coding-step replay. Validated with the schema
            // (cast-free): safeParse returns the typed value only for real AgentEvent types.
            const parsed = AgentEventTypeSchema.safeParse(signal.event.type);
            return parsed.success ? parsed.data : 'log';
        }
        case 'select':
            return 'decision.selected';
        case 'transition':
            return 'workflow.transitioned';
        case 'cancel':
        case 'cancelled':
            return 'node.cancelled';
        case 'success':
            return 'node.completed';
        case 'failure':
        case 'escalate':
            return 'node.failed';
        default:
            return assertNever(signal);
    }
}

function messageForSignal(signal: AbgSignal): string {
    switch (signal.type) {
        case 'started':
            return `node started: ${signal.nodeId}`;
        case 'progress':
            return signal.message ?? `node progress: ${signal.nodeId}`;
        case 'emit':
            return `node emitted event: ${signal.event.type}`;
        case 'select':
            return signal.reason ?? `node selected: ${signal.target}`;
        case 'transition':
            return `workflow transitioned: ${signal.from} -> ${signal.to}`;
        case 'spawn':
            return `actor spawned: ${signal.actor}`;
        case 'cancel':
            return signal.reason ?? `node cancel requested: ${signal.target}`;
        case 'success':
            return `node completed: ${signal.nodeId}`;
        case 'failure':
            return `node failed: ${signal.nodeId}`;
        case 'cancelled':
            return signal.reason ?? `node cancelled: ${signal.nodeId}`;
        case 'escalate':
            return signal.reason ?? `node escalated: ${signal.nodeId}`;
        case 'fallback':
            return signal.reason ?? `node requested fallback: ${signal.nodeId}`;
        default:
            return assertNever(signal);
    }
}

function modelProviderSelection(
    model: AbgNodeModelOptions | undefined,
): Pick<AgentEvent, 'modelProviderSelection'> | undefined {
    if (model === undefined) {
        return undefined;
    }
    return {
        modelProviderSelection: {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(model.variantID !== undefined ? { variantID: model.variantID } : {}),
        },
    };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled ABG signal: ${String(value)}`);
}
