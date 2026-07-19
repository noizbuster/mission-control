import type { AbgSignal } from '@mission-control/protocol';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { runLlmActor } from './llm-actor-node';

const NOW = '2026-07-13T00:00:00.000Z';

describe('LLMActor provider error stderr boundary', () => {
    it.each([1, 2])('keeps credential-like provider failures out of stderr (reproduction %i)', async () => {
        // Given
        const secret = ['sk', 'graph_stderr_repro_123'].join('-');
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'failing-model',
            doStream: async () => {
                throw new Error(`provider rejected ${secret}`);
            },
        });
        const stderrError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            // When
            const signals: AbgSignal[] = [];
            for await (const signal of runLlmActor({
                graphId: 'graph-stderr-redaction',
                nodeId: 'llm-failure',
                model,
                system: 'Test provider failures.',
                messages: [{ role: 'user', content: 'trigger provider failure' }],
                now: () => NOW,
            })) {
                signals.push(signal);
            }

            // Then
            const failure = signals.find((signal) => signal.type === 'failure');
            const errorEvent = signals.find(
                (signal): signal is Extract<AbgSignal, { type: 'emit' }> =>
                    signal.type === 'emit' && signal.event.type === 'llm.error',
            );
            expect(stderrError).not.toHaveBeenCalled();
            expect(failure).toMatchObject({
                type: 'failure',
                error: {
                    message: 'No output generated. Check the stream for errors.',
                    code: 'unknown',
                    providerError: true,
                    retryable: false,
                },
            });
            expect(errorEvent?.event.payload).toEqual({ error: 'provider rejected [REDACTED_CREDENTIAL]' });
            expect(JSON.stringify(signals)).not.toContain(secret);
        } finally {
            stderrError.mockRestore();
        }
    });
});
