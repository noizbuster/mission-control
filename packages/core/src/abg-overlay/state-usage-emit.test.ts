import type { AbgEmitMetadata } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { extractContextTokensUsedFromAbgEmit } from './state';

describe('extractContextTokensUsedFromAbgEmit', () => {
    it('reads direct inputTokens from a live llm.turn.completed emit', () => {
        // Given
        const emit: AbgEmitMetadata = {
            type: 'llm.turn.completed',
            payload: { usage: { inputTokens: 4200, outputTokens: 80 } },
        };

        // When
        const contextTokensUsed = extractContextTokensUsedFromAbgEmit(emit);

        // Then
        expect(contextTokensUsed).toBe(4200);
    });

    it('reads nested inputTokens.total from a live llm.turn.completed emit', () => {
        // Given
        const emit: AbgEmitMetadata = {
            type: 'llm.turn.completed',
            payload: { usage: { inputTokens: { total: 8800, noCache: 8800, cacheRead: 0, cacheWrite: 0 } } },
        };

        // When
        const contextTokensUsed = extractContextTokensUsedFromAbgEmit(emit);

        // Then
        expect(contextTokensUsed).toBe(8800);
    });

    it('ignores cumulative budget emits', () => {
        // Given
        const emit: AbgEmitMetadata = {
            type: 'policy.budget.accumulated',
            payload: { inputTokens: 99999 },
        };

        // When
        const contextTokensUsed = extractContextTokensUsedFromAbgEmit(emit);

        // Then
        expect(contextTokensUsed).toBeUndefined();
    });

    it('returns undefined when turn usage is missing', () => {
        // Given
        const emit: AbgEmitMetadata = { type: 'llm.turn.completed', payload: { text: 'done' } };

        // When
        const contextTokensUsed = extractContextTokensUsedFromAbgEmit(emit);

        // Then
        expect(contextTokensUsed).toBeUndefined();
    });

    it('returns undefined when turn usage is invalid', () => {
        // Given
        const emit: AbgEmitMetadata = {
            type: 'llm.turn.completed',
            payload: { usage: { inputTokens: -1 } },
        };

        // When
        const contextTokensUsed = extractContextTokensUsedFromAbgEmit(emit);

        // Then
        expect(contextTokensUsed).toBeUndefined();
    });
});
