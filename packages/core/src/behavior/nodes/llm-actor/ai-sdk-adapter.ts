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
import { errorToString } from '../../../util/error-to-string.js';
import { createAbgEmitSignal } from '../../abg-emit.js';

export type StreamPartAdapterContext = {
    readonly graphId: string | undefined;
    readonly nodeId: string;
    readonly now: () => string;
};

function emit(ctx: StreamPartAdapterContext, eventType: string, payload?: unknown): AbgSignal {
    return createAbgEmitSignal({
        graphId: ctx.graphId,
        nodeId: ctx.nodeId,
        source: 'llm-actor',
        eventType,
        timestamp: ctx.now(),
        payload,
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
        case 'text-delta':
            return [emit(ctx, 'llm.text.delta', { delta: part.text })];
        case 'reasoning-delta':
            return [emit(ctx, 'llm.reasoning.delta', { delta: part.text })];
        case 'tool-call':
            return [
                emit(ctx, 'llm.tool_call.proposed', {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: part.input,
                }),
            ];
        case 'tool-result':
            return [emit(ctx, 'tool.completed', { toolCallId: part.toolCallId, toolName: part.toolName })];
        case 'tool-error':
            return [emit(ctx, 'tool.failed', { toolCallId: part.toolCallId, toolName: part.toolName })];
        case 'tool-output-denied':
            return [emit(ctx, 'tool.denied', { toolCallId: part.toolCallId, toolName: part.toolName })];
        case 'error':
            return [emit(ctx, 'llm.error', { error: errorToString(part.error) })];
        default:
            // start-step / finish-step / finish / text-start / text-end / tool-input-* etc.
            // are intentionally quiet in Phase 0; turn boundaries are emitted by the node.
            return [];
    }
}
