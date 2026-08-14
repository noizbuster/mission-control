import { AbgSignalSchema, AgentEventSchema } from '@mission-control/protocol';
import { createChatStore } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import { createStoreChatOutput } from './store-chat-output';
import { interactiveGraphStreamSignal, renderInteractiveGraphDurableEvent } from './interactive-coding-graph-rendering';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';

const timestamp = '2026-07-17T00:00:00.000Z';

describe('graph occurrence transcript identity', () => {
    it('keeps repeated graph status and decision occurrences separate across turns', () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const firstState = createProviderRenderState('graph/one');
        const secondState = createProviderRenderState('graph/two');

        // When
        renderInteractiveGraphDurableEvent(output, firstState, attemptStarted('shared-node'));
        renderInteractiveGraphDurableEvent(output, firstState, decisionSelected('shared-node', 'first route'));
        renderInteractiveGraphDurableEvent(output, secondState, attemptStarted('shared-node'));
        renderInteractiveGraphDurableEvent(output, secondState, decisionSelected('shared-node', 'second route'));

        // Then
        expect(
            store
                .getSnapshot()
                .transcriptParts.filter((part) => part.type === 'status' || part.type === 'event')
                .map((part) => ({ id: part.id, type: part.type, text: part.text })),
        ).toEqual([
            { id: 'graph:graph%2Fone:occurrence:1', type: 'status', text: 'shared node…' },
            { id: 'graph:graph%2Fone:occurrence:2', type: 'event', text: 'first route' },
            { id: 'graph:graph%2Ftwo:occurrence:1', type: 'status', text: 'shared node…' },
            { id: 'graph:graph%2Ftwo:occurrence:2', type: 'event', text: 'second route' },
        ]);
    });

    it('uses stable embedded event IDs without consuming no-ID occurrence ordinals', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const firstState = createProviderRenderState('events/one');
        const secondState = createProviderRenderState('events/two');

        // When
        await interactiveGraphStreamSignal(output, firstState, '/workspace')(workflowTransition('shared/event'));
        renderInteractiveGraphDurableEvent(output, firstState, attemptStarted('after-event'));
        await interactiveGraphStreamSignal(output, secondState, '/workspace')(workflowTransition('shared/event'));
        renderInteractiveGraphDurableEvent(output, secondState, attemptStarted('after-event'));

        // Then
        expect(
            store
                .getSnapshot()
                .transcriptParts.filter((part) => part.type === 'event' || part.type === 'status')
                .map((part) => ({
                    id: part.id,
                    eventId: part.type === 'event' ? part.eventId : undefined,
                })),
        ).toEqual([
            { id: 'graph:events%2Fone:event:shared%2Fevent', eventId: 'shared/event' },
            { id: 'graph:events%2Fone:occurrence:1', eventId: undefined },
            { id: 'graph:events%2Ftwo:event:shared%2Fevent', eventId: 'shared/event' },
            { id: 'graph:events%2Ftwo:occurrence:1', eventId: undefined },
        ]);
    });
});

function attemptStarted(nodeId: string) {
    return AgentEventSchema.parse({
        type: 'attempt.started',
        timestamp,
        abg: { nodeId, attempt: 1 },
    });
}

function decisionSelected(nodeId: string, message: string) {
    return AgentEventSchema.parse({
        type: 'decision.selected',
        timestamp,
        message,
        abg: { nodeId },
    });
}

function workflowTransition(eventId: string) {
    return AbgSignalSchema.parse({
        type: 'emit',
        nodeId: 'workflow-router',
        event: {
            id: eventId,
            type: 'workflow.transitioned',
            source: 'test',
            timestamp,
            payload: { target: 'planner' },
        },
    });
}
