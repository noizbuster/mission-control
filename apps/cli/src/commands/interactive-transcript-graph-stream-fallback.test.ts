import { AbgSignalSchema } from '@mission-control/protocol';
import { createChatStore } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import { createStoreChatOutput } from './store-chat-output';
import { interactiveGraphStreamSignal, renderInteractiveGraphDurableEvent } from './interactive-coding-graph-rendering';
import {
    createRichRecording,
    graphDelta,
    renderState,
    turnCompleted,
    turnStarted,
} from './interactive-transcript-fallback-test-support';

describe('fallback-only graph transcript rendering', () => {
    it('forwards graph semantic and fallback output through ChatStore without legacy rows', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const state = renderState();
        const tap = interactiveGraphStreamSignal(output, state, '/workspace');

        // When
        await tap(turnStarted('adapter-node', 'turn'));
        await tap(graphDelta('adapter-node', 'llm.text.delta', 'semantic'));
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('adapter-node', 'semantic'));

        // Then
        expect(store.getOutput()).toBe('Assistant: semantic\n');
        expect(store.getSnapshot().transcriptParts).toEqual([
            {
                id: 'graph:outer-default:adapter-node-turn-started:assistant',
                type: 'assistant',
                text: 'semantic',
                status: 'completed',
            },
        ]);
    });

    it('accumulates graph text deltas under one node assistant ID and completes from durable text', async () => {
        // Given
        const recording = createRichRecording();
        const state = renderState();
        const tap = interactiveGraphStreamSignal(recording.output, state, '/workspace');

        // When
        await tap(turnStarted('answer-node', 'turn'));
        await tap(graphDelta('answer-node', 'llm.text.delta', 'Hel'));
        await tap(graphDelta('answer-node', 'llm.text.delta', 'lo'));
        renderInteractiveGraphDurableEvent(recording.output, state, turnCompleted('answer-node', 'Hello'));

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toEqual([
            {
                id: 'graph:outer-default:answer-node-turn-started:assistant',
                type: 'assistant',
                text: 'Hel',
                status: 'streaming',
            },
            {
                id: 'graph:outer-default:answer-node-turn-started:assistant',
                type: 'assistant',
                text: 'Hello',
                status: 'streaming',
            },
            {
                id: 'graph:outer-default:answer-node-turn-started:assistant',
                type: 'assistant',
                text: 'Hello',
                status: 'completed',
            },
        ]);
        expect(recording.rawWrites).toEqual([]);
        expect(recording.fallbackBytes.join('')).toBe('Assistant: Hello\n');
    });

    it('keeps parallel graph node fallback streams independent until delayed durable completion', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const state = renderState();
        const tap = interactiveGraphStreamSignal(output, state, '/workspace');

        // When
        await tap(AbgSignalSchema.parse({ type: 'started', nodeId: 'parallel-alpha' }));
        await tap(AbgSignalSchema.parse({ type: 'started', nodeId: 'parallel-beta' }));
        await tap(turnStarted('parallel-alpha', 'turn'));
        await tap(turnStarted('parallel-beta', 'turn'));
        await tap(graphDelta('parallel-alpha', 'llm.text.delta', 'alpha'));
        await tap(graphDelta('parallel-beta', 'llm.text.delta', 'beta'));
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('parallel-alpha', 'alpha'));
        renderInteractiveGraphDurableEvent(output, state, turnCompleted('parallel-beta', 'beta'));

        // Then
        expect(store.getOutput()).toBe('▸ parallel-alpha\n▸ parallel-beta\nAssistant: alpha\nAssistant: beta\n');
        expect(
            store
                .getSnapshot()
                .transcriptParts.filter((part) => part.type === 'assistant')
                .map((part) => ({ id: part.id, text: part.text, status: part.status })),
        ).toEqual([
            {
                id: 'graph:outer-default:parallel-alpha-turn-started:assistant',
                text: 'alpha',
                status: 'completed',
            },
            {
                id: 'graph:outer-default:parallel-beta-turn-started:assistant',
                text: 'beta',
                status: 'completed',
            },
        ]);
        expect(store.getSnapshot().transcriptParts.filter((part) => part.type === 'legacy')).toEqual([]);
    });

    it('starts a same-node assistant transcript fresh on each graph LLM turn', async () => {
        // Given
        const recording = createRichRecording();
        const state = renderState();
        const tap = interactiveGraphStreamSignal(recording.output, state, '/workspace');

        // When
        await tap(turnStarted('loop-node', 'turn-one'));
        await tap(graphDelta('loop-node', 'llm.text.delta', 'first-'));
        await tap(graphDelta('loop-node', 'llm.text.delta', 'one'));
        renderInteractiveGraphDurableEvent(recording.output, state, turnCompleted('loop-node', 'first-one'));
        await tap(turnStarted('loop-node', 'turn-two'));
        await tap(graphDelta('loop-node', 'llm.text.delta', 'second-'));
        await tap(graphDelta('loop-node', 'llm.text.delta', 'two'));
        renderInteractiveGraphDurableEvent(recording.output, state, turnCompleted('loop-node', 'second-two'));

        // Then
        const assistantTexts = recording.transcriptWrites.map(({ part }) => part.text);
        expect(assistantTexts.slice(0, 3)).toEqual(['first-', 'first-one', 'first-one']);
        expect(assistantTexts.slice(3)).toEqual(['second-', 'second-two', 'second-two']);
        expect(recording.rawWrites).toEqual([]);
        expect(recording.fallbackBytes.join('')).toBe('Assistant: first-one\nAssistant: second-two\n');
    });

    it('starts a same-node hidden reasoning transcript fresh on each graph LLM turn', async () => {
        // Given
        const recording = createRichRecording(false);
        const state = renderState();
        const tap = interactiveGraphStreamSignal(recording.output, state, '/workspace');

        // When
        await tap(turnStarted('reasoning-loop', 'turn-one'));
        await tap(graphDelta('reasoning-loop', 'llm.reasoning.delta', 'r1:'));
        await tap(graphDelta('reasoning-loop', 'llm.reasoning.delta', 'a'));
        renderInteractiveGraphDurableEvent(recording.output, state, turnCompleted('reasoning-loop', ''));
        await tap(turnStarted('reasoning-loop', 'turn-two'));
        await tap(graphDelta('reasoning-loop', 'llm.reasoning.delta', 'r2:'));
        await tap(graphDelta('reasoning-loop', 'llm.reasoning.delta', 'b'));
        renderInteractiveGraphDurableEvent(recording.output, state, turnCompleted('reasoning-loop', ''));

        // Then
        const reasoningTexts = recording.transcriptWrites
            .filter(({ part }) => part.type === 'reasoning')
            .map(({ part }) => part.text);
        expect(reasoningTexts.slice(0, 3)).toEqual(['r1:', 'r1:a', 'r1:a']);
        expect(recording.rawWrites).toEqual([]);
        expect(recording.fallbackBytes.join('')).toBe('');
        expect(reasoningTexts.slice(3)).toEqual(['r2:', 'r2:b', 'r2:b']);
    });

    it('keeps hidden graph reasoning semantic and collision-free from the assistant row', async () => {
        // Given
        const recording = createRichRecording(false);
        const state = renderState();
        const tap = interactiveGraphStreamSignal(recording.output, state, '/workspace');

        // When
        await tap(turnStarted('shared-node', 'turn'));
        await tap(graphDelta('shared-node', 'llm.reasoning.delta', 'inspect '));
        await tap(graphDelta('shared-node', 'llm.reasoning.delta', 'evidence'));
        await tap(graphDelta('shared-node', 'llm.text.delta', 'answer'));
        renderInteractiveGraphDurableEvent(recording.output, state, turnCompleted('shared-node', 'answer'));

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toEqual([
            {
                id: 'graph:outer-default:shared-node-turn-started:reasoning',
                type: 'reasoning',
                text: 'inspect ',
                status: 'streaming',
            },
            {
                id: 'graph:outer-default:shared-node-turn-started:reasoning',
                type: 'reasoning',
                text: 'inspect evidence',
                status: 'streaming',
            },
            {
                id: 'graph:outer-default:shared-node-turn-started:assistant',
                type: 'assistant',
                text: 'answer',
                status: 'streaming',
            },
            {
                id: 'graph:outer-default:shared-node-turn-started:assistant',
                type: 'assistant',
                text: 'answer',
                status: 'completed',
            },
            {
                id: 'graph:outer-default:shared-node-turn-started:reasoning',
                type: 'reasoning',
                text: 'inspect evidence',
                status: 'completed',
            },
        ]);
        expect(new Set(recording.transcriptWrites.map(({ part }) => part.id))).toEqual(
            new Set([
                'graph:outer-default:shared-node-turn-started:assistant',
                'graph:outer-default:shared-node-turn-started:reasoning',
            ]),
        );
        expect(recording.rawWrites).toEqual([]);
        expect(recording.fallbackBytes.join('')).toBe('Assistant: answer\n');
    });
});
