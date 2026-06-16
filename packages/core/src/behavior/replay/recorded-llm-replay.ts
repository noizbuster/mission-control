/**
 * Deterministic LLM replay from recorded provider envelopes (ABG §7.5, Phase 11.7).
 *
 * On replay, an `LLMActor` turn is driven by RECORDED envelopes (the text/tool-call/tool-result
 * the model produced) rather than re-calling the model — preserving determinism. This module is
 * the replay primitive: given a `RecordedTurn`, it emits the SAME ABG signal sequence a live
 * `runLlmActor` would (via the shared `createAbgEmitSignal` + the canonical `llm.*`/`tool.*`
 * vocabulary), so a replayed Timeline is byte-identical to the recorded one.
 *
 * The recording contract is the Phase-1 `LlmActorTurnResult.responseMessages` + the emitted
 * `llm.*`/`tool.*` events — nothing else. Phase 7 wires this into full Timeline replay; the
 * primitive + its identity guarantee land here.
 */
import type { AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit.js';

export type RecordedToolCall = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
};

export type RecordedToolResult = {
    readonly toolCallId: string;
    readonly toolName: string;
};

export type RecordedTurn = {
    readonly text: string;
    readonly toolCalls: readonly RecordedToolCall[];
    readonly toolResults: readonly RecordedToolResult[];
    readonly usage: unknown;
};

export type ReplayContext = {
    readonly graphId: string | undefined;
    readonly nodeId: string;
    readonly now: () => string;
};

/**
 * Reconstruct the ABG signal stream for one turn from a recording (no model call).
 * The sequence mirrors `runLlmActor`: started → llm.turn.started → text/tool deltas/proposals
 * → tool.completed → llm.turn.completed → success.
 */
export async function* replayRecordedTurn(recording: RecordedTurn, ctx: ReplayContext): AsyncIterable<AbgSignal> {
    const graphIdPart = ctx.graphId !== undefined ? { graphId: ctx.graphId } : {};
    let emitIndex = 0;
    const emit = (eventType: string, payload?: unknown): AbgSignal => {
        emitIndex += 1;
        return createAbgEmitSignal({
            graphId: ctx.graphId,
            nodeId: ctx.nodeId,
            source: 'llm-actor',
            eventType,
            timestamp: ctx.now(),
            // Deterministic id: turn-local index, so replay is byte-identical across runs.
            id: `${ctx.graphId ?? 'graph'}.${ctx.nodeId}.${eventType}.${emitIndex}`,
            ...(payload !== undefined ? { payload } : {}),
        });
    };

    yield { type: 'started', nodeId: ctx.nodeId, ...graphIdPart };
    yield emit('llm.turn.started');

    if (recording.text.length > 0) {
        yield emit('llm.text.delta', { delta: recording.text });
    }
    for (const call of recording.toolCalls) {
        yield emit('llm.tool_call.proposed', {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
        });
    }
    for (const result of recording.toolResults) {
        yield emit('tool.completed', { toolCallId: result.toolCallId, toolName: result.toolName });
    }

    yield emit('llm.turn.completed', { text: recording.text, usage: recording.usage });
    yield {
        type: 'success',
        nodeId: ctx.nodeId,
        ...graphIdPart,
        result: { text: recording.text, usage: recording.usage, responseMessages: [] },
    };
}

/** Extract the recorded event types from a replayed signal stream (for byte-identity assertions). */
export function recordedEventTypes(signals: readonly AbgSignal[]): readonly string[] {
    return signals
        .filter((signal): signal is Extract<AbgSignal, { type: 'emit' }> => signal.type === 'emit')
        .map((signal) => signal.event.type);
}
