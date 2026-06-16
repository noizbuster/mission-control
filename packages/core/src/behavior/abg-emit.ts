/**
 * Shared ABG emit-signal builder — the single source for the
 * `{ type: 'emit', graphId?, nodeId, event }` AbgSignal shape.
 *
 * Used by both the mock leaf nodes (`nodes/leaf-nodes.ts`) and the real LLMActor node
 * (`nodes/llm-actor/`), so there is one constructor (not two) for the ABG §10.3 event
 * vocabulary. Event ids are graph-scoped and unique via a monotonic counter — the prior
 * `${graphId}.${nodeId}.${eventType}` scheme collided on repeated event types (e.g.
 * per-token `llm.text.delta`).
 *
 * **Determinism (review #9):** the counter is scoped per `graphId`, NOT process-global,
 * and `resetEmitSequence(graphId)` is called by the coordinator at the start of every
 * `runAbgGraph` invocation. So the in-memory node-level signal stream is reproducible:
 * re-running the same graph (same inputs) yields byte-identical node-level event ids —
 * enabling diff/identity assertions and the Phase-7 deterministic replay path (which also
 * accepts explicit ids). This does NOT affect persisted event ids: the JSONL store mints a
 * fresh `randomUUID()` `eventId` per event (`jsonl-session-event-store.ts`), so persisted
 * ids are globally unique regardless of this counter.
 */
import type { AbgEmbeddedEvent, AbgSignal } from '@mission-control/protocol';

export type AbgEmitInput = {
    readonly graphId: string | undefined;
    readonly nodeId: string;
    readonly eventType: string;
    readonly source?: string;
    readonly timestamp: string;
    readonly payload?: unknown;
    /**
     * Explicit event id. When omitted, a graph-scoped monotonic counter is used (unique within
     * a process). Replay passes a DETERMINISTIC id so a replayed stream is byte-identical to
     * the recorded one regardless of process/counter state (ABG §7.5).
     */
    readonly id?: string;
};

/**
 * Per-graph emit counters. Keyed by `graphId` (falling back to the `'graph'` sentinel for
 * graph-less emissions) so unrelated graphs never share sequence space. The coordinator
 * resets a graph's counter at the start of each run (`resetEmitSequence`) so sequential
 * runs of the same graph are reproducible.
 *
 * Note: concurrent runs of the SAME graph would share/reset this entry; nodes that need
 * full per-run isolation can pass an explicit deterministic `id` (as the replay path does).
 */
const graphEmitSequence = new Map<string, number>();

/**
 * Reset the monotonic emit counter for a graph to its initial state. Called by the
 * coordinator at run start so each run begins the node-level id sequence at 1 — making
 * re-runs byte-identical. Harmless to call for graphs that have never emitted.
 */
export function resetEmitSequence(graphId: string | undefined): void {
    graphEmitSequence.set(graphId ?? 'graph', 0);
}

/** Advance the per-graph counter and return the next deterministic id. */
function nextEmitId(graphKey: string, nodeId: string, eventType: string): string {
    const next = (graphEmitSequence.get(graphKey) ?? 0) + 1;
    graphEmitSequence.set(graphKey, next);
    return `${graphKey}.${nodeId}.${eventType}.${next}`;
}

export function createAbgEmitSignal(input: AbgEmitInput): AbgSignal {
    const graphKey = input.graphId ?? 'graph';
    const id = input.id ?? nextEmitId(graphKey, input.nodeId, input.eventType);
    const event: AbgEmbeddedEvent = {
        id,
        type: input.eventType,
        source: input.source ?? input.nodeId,
        timestamp: input.timestamp,
    };
    if (input.payload !== undefined) {
        event.payload = input.payload;
    }
    return {
        type: 'emit',
        nodeId: input.nodeId,
        ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
        event,
    };
}
