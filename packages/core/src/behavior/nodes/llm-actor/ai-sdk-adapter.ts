/**
 * Maps a Vercel AI SDK `streamText` fullStream part into ABG Signals.
 *
 * This is the single normalization seam: the rest of the ABG graph never touches
 * provider/SDK specifics. Each SDK stream part becomes a typed ABG `emit` event
 * (e.g. `llm.text.delta`, `llm.tool_call.proposed`, `tool.completed`, `tool.failed`),
 * preserving the ABG §10.3 vocabulary ("a tool call is a proposed action").
 *
 * Phase 0 scope: the high-signal parts. `start-step` / `finish-step` / `finish` are
 * intentionally quiet — the LLMActor node emits its own `llm.turn.started` /
 * `llm.turn.completed` boundaries, and per-step telemetry lands in Phase 2's
 * token-stream tiering.
 */

import type { AbgSignal } from '@mission-control/protocol';
import type { TextStreamPart, ToolSet } from 'ai';
import { observableToolInput } from '../../../providers/model-message-observability';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    type ObservabilityTextStream,
} from '../../../providers/observability-redactor';
import { errorToString } from '../../../util/error-to-string';
import { createAbgEmitSignal } from '../../abg-emit';
import type { AbgToolSettlementLedger } from './abg-tool-bridge';

export type StreamPartAdapterContext = {
    readonly graphId: string | undefined;
    readonly nodeId: string;
    readonly now: () => string;
    /**
     * The per-turn settlement ledger the tool bridge writes. When present, the `tool-result`
     * case reads it to recover the settlement's true status + output/error (the SDK collapses a
     * failed settlement to a `tool-result` carrying an error string). When absent (no registry,
     * or a provider-executed tool), the emit falls back to the part's own `output`/`error`.
     */
    readonly settlementLedger?: AbgToolSettlementLedger;
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly observabilityStreams?: StreamPartObservabilityState;
};

export type StreamPartObservabilityState = {
    readonly text: Map<string, ObservabilityTextStream>;
    readonly reasoning: Map<string, ObservabilityTextStream>;
};

const defaultObservabilityRedactor = createObservabilityRedactor();

export function createStreamPartObservabilityState(): StreamPartObservabilityState {
    return { text: new Map(), reasoning: new Map() };
}

function emit(ctx: StreamPartAdapterContext, eventType: string, payload?: unknown): AbgSignal {
    const redactor = ctx.observabilityRedactor ?? defaultObservabilityRedactor;
    return createAbgEmitSignal({
        graphId: ctx.graphId,
        nodeId: ctx.nodeId,
        source: 'llm-actor',
        eventType,
        timestamp: ctx.now(),
        ...(payload !== undefined ? { payload: redactor.redactValue(payload) } : {}),
    });
}

/**
 * Convert one SDK stream part into zero or more ABG Signals.
 * Returns an array because some parts may map to several signals in later phases.
 */
export function abgSignalsFromStreamPart(
    part: TextStreamPart<ToolSet>,
    ctx: StreamPartAdapterContext,
): readonly AbgSignal[] {
    switch (part.type) {
        case 'text-start':
            ctx.observabilityStreams?.text.set(part.id, redactorFor(ctx).createTextStream());
            return [];
        case 'text-delta':
            return streamDeltaSignals(ctx, ctx.observabilityStreams?.text, part.id, part.text, 'llm.text.delta');
        case 'text-end':
            return flushStreamSignals(ctx, ctx.observabilityStreams?.text, part.id, 'llm.text.delta');
        case 'reasoning-start':
            ctx.observabilityStreams?.reasoning.set(part.id, redactorFor(ctx).createTextStream());
            return [];
        case 'reasoning-delta':
            return streamDeltaSignals(
                ctx,
                ctx.observabilityStreams?.reasoning,
                part.id,
                part.text,
                'llm.reasoning.delta',
            );
        case 'reasoning-end':
            return flushStreamSignals(ctx, ctx.observabilityStreams?.reasoning, part.id, 'llm.reasoning.delta');
        case 'tool-call':
            return [
                emit(ctx, 'llm.tool_call.proposed', {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: observableToolInput(part.toolName, part.input),
                }),
            ];
        case 'tool-result': {
            // Recover the settlement's TRUE status/output/error from the ledger the bridge
            // wrote before this part fired. The SDK emits a `tool-result` for a failed
            // settlement too (the bridge surfaces failures to the model as a string), so
            // without the ledger a failed tool would be mislabeled `completed`.
            const settlement = ctx.settlementLedger?.lookup(part.toolCallId);
            if (settlement?.status === 'failed') {
                return [
                    emit(ctx, 'tool.failed', {
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        ...(settlement.error !== undefined ? { error: settlement.error } : {}),
                    }),
                ];
            }
            const output = settlement?.output ?? part.output;
            return [
                emit(ctx, 'tool.completed', {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    ...(output !== undefined ? { output } : {}),
                    // Carry the structured output object so the graph renderer recovers `Applied patch:`/
                    // `Applied edit:`/`Created file:` detail the model-facing `output` string loses —
                    // parity with the flat path's `settlement.structuredOutput`.
                    ...(settlement?.structuredOutput !== undefined
                        ? { structuredOutput: settlement.structuredOutput }
                        : {}),
                }),
            ];
        }
        case 'tool-error': {
            // `execute` threw (rare: the bridge catches settlement failures and returns a
            // string, so this fires only for genuine bridge/registry errors or aborts). Coerce
            // the SDK's `unknown` error into a ProtocolError so the emit carries detail.
            const message = part.error !== undefined ? errorToString(part.error) : undefined;
            return [
                emit(ctx, 'tool.failed', {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    ...(message !== undefined ? { error: { code: 'unknown', message, retryable: false } } : {}),
                }),
            ];
        }
        case 'tool-output-denied':
            return [emit(ctx, 'tool.denied', { toolCallId: part.toolCallId, toolName: part.toolName })];
        case 'error':
            return [
                ...flushAllStreams(ctx),
                emit(ctx, 'llm.error', { error: redactorFor(ctx).redactText(errorToString(part.error)) }),
            ];
        case 'abort':
        case 'finish':
            return flushAllStreams(ctx);
        default:
            // start-step / finish-step / finish / text-start / text-end / tool-input-* etc.
            // are intentionally quiet in Phase 0; turn boundaries are emitted by the node.
            return [];
    }
}

function streamDeltaSignals(
    ctx: StreamPartAdapterContext,
    streams: Map<string, ObservabilityTextStream> | undefined,
    id: string,
    delta: string,
    eventType: 'llm.text.delta' | 'llm.reasoning.delta',
): readonly AbgSignal[] {
    if (streams === undefined) {
        return [emit(ctx, eventType, { delta: redactorFor(ctx).redactText(delta) })];
    }
    let stream = streams.get(id);
    if (stream === undefined) {
        stream = redactorFor(ctx).createTextStream();
        streams.set(id, stream);
    }
    return stream.push(delta).map((safeDelta) => emit(ctx, eventType, { delta: safeDelta }));
}

function flushStreamSignals(
    ctx: StreamPartAdapterContext,
    streams: Map<string, ObservabilityTextStream> | undefined,
    id: string,
    eventType: 'llm.text.delta' | 'llm.reasoning.delta',
): readonly AbgSignal[] {
    const stream = streams?.get(id);
    if (stream === undefined) {
        return [];
    }
    streams?.delete(id);
    return stream.flush().map((safeDelta) => emit(ctx, eventType, { delta: safeDelta }));
}

function flushAllStreams(ctx: StreamPartAdapterContext): readonly AbgSignal[] {
    const signals: AbgSignal[] = [];
    for (const id of [...(ctx.observabilityStreams?.text.keys() ?? [])]) {
        signals.push(...flushStreamSignals(ctx, ctx.observabilityStreams?.text, id, 'llm.text.delta'));
    }
    for (const id of [...(ctx.observabilityStreams?.reasoning.keys() ?? [])]) {
        signals.push(...flushStreamSignals(ctx, ctx.observabilityStreams?.reasoning, id, 'llm.reasoning.delta'));
    }
    return signals;
}

function redactorFor(ctx: StreamPartAdapterContext): ObservabilityRedactor {
    return ctx.observabilityRedactor ?? defaultObservabilityRedactor;
}
