import { AgentEventSchema } from '@mission-control/protocol';
import { createChatStore } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import { createStoreChatOutput } from './store-chat-output';
import { interactiveGraphStreamSignal, renderInteractiveGraphDurableEvent } from './interactive-coding-graph-rendering';
import {
    graphDelta,
    renderState,
    toolCompleted,
    turnCompleted,
    turnStarted,
} from './interactive-transcript-fallback-test-support';

describe('fallback-only graph transcript rendering', () => {
    it('keeps delayed same-node assistant and reasoning terminals FIFO by started turn', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const state = renderState('outer/fifo');
        const tap = interactiveGraphStreamSignal(output, state, '/workspace');

        // When
        await tap(turnStarted('loop-node', 'turn-one'));
        await tap(graphDelta('loop-node', 'llm.reasoning.delta', 'reason-one'));
        await tap(graphDelta('loop-node', 'llm.text.delta', 'answer-one'));
        await tap(turnStarted('loop-node', 'turn-two'));
        await tap(graphDelta('loop-node', 'llm.reasoning.delta', 'reason-two'));
        await tap(graphDelta('loop-node', 'llm.text.delta', 'answer-two'));
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('loop-node', 'answer-one'));
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('loop-node', 'answer-two'));

        // Then
        expect(
            store
                .getSnapshot()
                .transcriptParts.filter((part) => part.type === 'assistant' || part.type === 'reasoning')
                .map((part) => ({ id: part.id, text: part.text, status: part.status })),
        ).toEqual([
            {
                id: 'graph:outer%2Ffifo:loop-node-turn-one-started:reasoning',
                text: 'reason-one',
                status: 'completed',
            },
            {
                id: 'graph:outer%2Ffifo:loop-node-turn-one-started:assistant',
                text: 'answer-one',
                status: 'completed',
            },
            {
                id: 'graph:outer%2Ffifo:loop-node-turn-two-started:reasoning',
                text: 'reason-two',
                status: 'completed',
            },
            {
                id: 'graph:outer%2Ffifo:loop-node-turn-two-started:assistant',
                text: 'answer-two',
                status: 'completed',
            },
        ]);
    });

    it('namespaces reused embedded start IDs by outer coding turn', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const firstState = renderState('outer/one');
        const secondState = renderState('outer/two');
        const firstTap = interactiveGraphStreamSignal(output, firstState, '/workspace');
        const secondTap = interactiveGraphStreamSignal(output, secondState, '/workspace');

        // When
        await firstTap(turnStarted('shared-node', 'same-embedded-id'));
        await firstTap(graphDelta('shared-node', 'llm.text.delta', 'first'));
        renderInteractiveGraphDurableEvent(output, firstState, turnCompleted('shared-node', 'first'));
        await secondTap(turnStarted('shared-node', 'same-embedded-id'));
        await secondTap(graphDelta('shared-node', 'llm.text.delta', 'second'));
        renderInteractiveGraphDurableEvent(output, secondState, turnCompleted('shared-node', 'second'));

        // Then
        expect(
            store
                .getSnapshot()
                .transcriptParts.filter((part) => part.type === 'assistant')
                .map((part) => ({ id: part.id, text: part.text })),
        ).toEqual([
            { id: 'graph:outer%2Fone:shared-node-same-embedded-id-started:assistant', text: 'first' },
            { id: 'graph:outer%2Ftwo:shared-node-same-embedded-id-started:assistant', text: 'second' },
        ]);
    });

    it('does not consume a same-node FIFO turn for a mismatched durable terminal', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const state = renderState('outer-mismatch');
        const tap = interactiveGraphStreamSignal(output, state, '/workspace');

        // When
        await tap(turnStarted('queued-node', 'turn-one'));
        await tap(graphDelta('queued-node', 'llm.text.delta', 'first'));
        await tap(turnStarted('queued-node', 'turn-two'));
        await tap(graphDelta('queued-node', 'llm.text.delta', 'second'));
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('other-node', 'mismatch'));
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('queued-node', 'first'));
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('queued-node', 'second'));

        // Then
        expect(
            store
                .getSnapshot()
                .transcriptParts.filter((part) => part.type === 'assistant')
                .map((part) => ({ id: part.id, text: part.text })),
        ).toEqual([
            { id: 'graph:outer-mismatch:queued-node-turn-one-started:assistant', text: 'first' },
            { id: 'graph:outer-mismatch:queued-node-turn-two-started:assistant', text: 'second' },
        ]);
    });

    it('keeps same-node tool summaries scoped to their FIFO graph turns', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const state = renderState('outer-tools');
        const tap = interactiveGraphStreamSignal(output, state, '/workspace');

        // When
        await tap(turnStarted('tool-node', 'turn-one'));
        await tap(turnStarted('tool-node', 'turn-two'));
        renderInteractiveGraphDurableEvent(
            output,
            state,
            toolCompleted('tool-node', { toolCallId: 'call-one', toolName: 'repo.read', output: 'one' }),
        );
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('tool-node', 'first'));
        renderInteractiveGraphDurableEvent(
            output,
            state,
            toolCompleted('tool-node', { toolCallId: 'call-two', toolName: 'repo.search', output: 'two' }),
        );
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('tool-node', 'second'));

        // Then
        expect(
            store
                .getSnapshot()
                .transcriptParts.filter((part) => part.type === 'status' && part.status === 'completed')
                .map((part) => ({ id: part.id, text: part.text })),
        ).toEqual([
            { id: 'graph:outer-tools:tool-node-turn-one-started:tools', text: '✓ 1 tool (repo.read)' },
            { id: 'graph:outer-tools:tool-node-turn-two-started:tools', text: '✓ 1 tool (repo.search)' },
        ]);
    });

    it('keeps same-node durable errors scoped to their started graph turns', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const state = renderState('outer-errors');
        const tap = interactiveGraphStreamSignal(output, state, '/workspace');
        const errorEvent = (message: string) =>
            AgentEventSchema.parse({
                type: 'model.call.failed',
                timestamp: '2026-07-17T00:00:00.000Z',
                abg: { nodeId: 'error-node', emit: { type: 'llm.error', payload: { error: message } } },
            });

        // When
        await tap(turnStarted('error-node', 'turn-one'));
        await tap(turnStarted('error-node', 'turn-two'));
        renderInteractiveGraphDurableEvent(output, state, errorEvent('first error'));
        renderInteractiveGraphDurableEvent(output, state, errorEvent('second error'));

        // Then
        expect(
            store
                .getSnapshot()
                .transcriptParts.filter((part) => part.type === 'error')
                .map((part) => ({ id: part.id, text: part.text })),
        ).toEqual([
            { id: 'graph:outer-errors:error-node-turn-one-started:error', text: 'first error' },
            { id: 'graph:outer-errors:error-node-turn-two-started:error', text: 'second error' },
        ]);
    });
});
