import { AbgSignalSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    interactiveGraphStreamSignal,
    renderInteractiveGraphDurableEvent,
} from './interactive-coding-graph-rendering';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';
import {
    createRichRecording,
    renderState,
    toolCompleted,
    turnStarted,
} from './interactive-transcript-fallback-test-support';

const timestamp = '2026-07-17T00:00:00.000Z';

function proposedSignal(nodeId: string, toolCallId: string, toolName: string) {
    return AbgSignalSchema.parse({
        type: 'emit',
        nodeId,
        event: {
            id: `${nodeId}-propose-${toolCallId}`,
            type: 'llm.tool_call.proposed',
            source: 'test',
            timestamp,
            payload: { toolCallId, toolName, input: {} },
        },
    });
}

function toolCompletedSignal(nodeId: string, toolCallId: string, toolName: string, output: string) {
    return AbgSignalSchema.parse({
        type: 'emit',
        nodeId,
        event: {
            id: `${nodeId}-complete-${toolCallId}`,
            type: 'tool.completed',
            source: 'test',
            timestamp,
            payload: { toolCallId, toolName, output },
        },
    });
}

function findPart(toolCallId: string) {
    return (part: { readonly toolCallId?: string }): boolean => part.toolCallId === toolCallId;
}

function lastPartForToolCall(parts: readonly { readonly toolCallId?: string }[], toolCallId: string) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (part !== undefined && part.toolCallId === toolCallId) return part;
    }
    return undefined;
}

describe('live tool settlement via graph signals', () => {
    it('settles a tool row immediately on tool.completed signal (not deferred to graph-end)', async () => {
        const recording = createRichRecording();
        const state = renderState('turn-live');
        const stream = interactiveGraphStreamSignal(recording.output, state, '/workspace');

        await stream(turnStarted('maturity-sample', 'turn-1'));
        await stream(proposedSignal('maturity-sample', 'call-grep-1', 'grep'));
        await stream(toolCompletedSignal('maturity-sample', 'call-grep-1', 'grep', 'result line'));

        const parts = recording.transcriptWrites.map((w) => w.part);
        const settled = lastPartForToolCall(parts, 'call-grep-1');
        expect(settled).toBeDefined();
        expect(settled?.status).toBe('completed');
        expect(state.liveSettledToolCallIds.has('call-grep-1')).toBe(true);
    });

    it('deferred durable event is skipped when the live signal already settled the toolCallId', async () => {
        const recording = createRichRecording();
        const state = renderState('turn-dedupe');
        const stream = interactiveGraphStreamSignal(recording.output, state, '/workspace');

        await stream(turnStarted('maturity-sample', 'turn-1'));
        await stream(proposedSignal('maturity-sample', 'call-read-1', 'read'));
        await stream(toolCompletedSignal('maturity-sample', 'call-read-1', 'read', 'text'));

        const writesBeforeDeferred = recording.transcriptWrites.length;

        renderInteractiveGraphDurableEvent(
            recording.output,
            state,
            toolCompleted('maturity-sample', { toolCallId: 'call-read-1', toolName: 'read', output: 'text' }),
        );

        const writesAfterDeferred = recording.transcriptWrites.length;
        expect(writesAfterDeferred).toBe(writesBeforeDeferred);
    });

    it('deferred durable event still renders when no live signal handled it (graph-durable-only path)', () => {
        const recording = createRichRecording();
        const state = renderState('turn-deferred-only');

        renderInteractiveGraphDurableEvent(
            recording.output,
            state,
            toolCompleted('maturity-sample', { toolCallId: 'call-grep-2', toolName: 'grep', output: 'late result' }),
        );

        const parts = recording.transcriptWrites.map((w) => w.part);
        const settled = lastPartForToolCall(parts, 'call-grep-2');
        expect(settled).toBeDefined();
        expect(settled?.status).toBe('completed');
    });

    it('parallel tool calls all settle live without FIFO cross-talk', async () => {
        const recording = createRichRecording();
        const state = createProviderRenderState('turn-parallel-live');
        const stream = interactiveGraphStreamSignal(recording.output, state, '/workspace');

        await stream(turnStarted('maturity-sample', 'turn-parallel'));
        await stream(proposedSignal('maturity-sample', 'call-A', 'grep'));
        await stream(proposedSignal('maturity-sample', 'call-B', 'grep'));
        await stream(proposedSignal('maturity-sample', 'call-C', 'read'));

        await stream(toolCompletedSignal('maturity-sample', 'call-B', 'grep', 'B result'));
        await stream(toolCompletedSignal('maturity-sample', 'call-A', 'grep', 'A result'));
        await stream(toolCompletedSignal('maturity-sample', 'call-C', 'read', 'C result'));

        const parts = recording.transcriptWrites.map((w) => w.part);
        for (const callId of ['call-A', 'call-B', 'call-C']) {
            const settled = lastPartForToolCall(parts, callId);
            expect(settled, `${callId} should be settled`).toBeDefined();
            expect(settled?.status).toBe('completed');
        }
        expect(state.liveSettledToolCallIds.has('call-A')).toBe(true);
        expect(state.liveSettledToolCallIds.has('call-B')).toBe(true);
        expect(state.liveSettledToolCallIds.has('call-C')).toBe(true);
    });
});
