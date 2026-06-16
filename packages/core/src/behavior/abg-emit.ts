/**
 * Shared ABG emit-signal builder — the single source for the
 * `{ type: 'emit', graphId?, nodeId, event }` AbgSignal shape.
 *
 * Used by both the mock leaf nodes (`nodes/leaf-nodes.ts`) and the real LLMActor node
 * (`nodes/llm-actor/`), so there is one constructor (not two) for the ABG §10.3 event
 * vocabulary. Event ids are graph-scoped and unique via a monotonic counter — the prior
 * `${graphId}.${nodeId}.${eventType}` scheme collided on repeated event types (e.g.
 * per-token `llm.text.delta`).
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

let emitSequence = 0;

export function createAbgEmitSignal(input: AbgEmitInput): AbgSignal {
    const sequenceUsed = input.id === undefined;
    if (sequenceUsed) {
        emitSequence += 1;
    }
    const event: AbgEmbeddedEvent = {
        id: input.id ?? `${input.graphId ?? 'graph'}.${input.nodeId}.${input.eventType}.${emitSequence}`,
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
