import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { wrapFlatProviderAsSdkModel } from '../../../providers/ai-sdk/flat-provider-bridge';
import { createDeterministicProvider } from '../../../providers/deterministic-provider';
import { runLlmActor } from './llm-actor-node';
import { messages, NOW } from './llm-actor-node-test-support';

describe('LLM actor chunk timeout', () => {
    it('classifies an AI SDK chunk deadline as a retryable provider timeout', async () => {
        // Given
        const model = wrapFlatProviderAsSdkModel({
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 100 },
                { kind: 'response_completed', content: 'late response' },
            ]),
            providerID: 'zai-coding-plan',
            modelID: 'glm-5.2',
            retryLimit: 0,
        });
        const signals: AbgSignal[] = [];

        // When
        for await (const signal of runLlmActor({
            graphId: 'chunk-timeout-graph',
            nodeId: 'chunk-timeout-node',
            model,
            system: 'Classify a timeout.',
            messages,
            timeoutMs: 20,
            now: () => NOW,
        })) {
            signals.push(signal);
        }

        // Then
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: { code: 'provider_timeout', retryable: true },
        });
    });
});
