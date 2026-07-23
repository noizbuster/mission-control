import { describe, expect, it } from 'vitest';
import { nextProviderChunkTimeoutMs } from './provider-turn-timeout';

describe('nextProviderChunkTimeoutMs', () => {
    it('doubles the next no-output timeout before retrying', () => {
        // Given
        const currentTimeoutMs = 120_000;

        // When
        const timeoutMs = nextProviderChunkTimeoutMs(currentTimeoutMs);

        // Then
        expect(timeoutMs).toBe(240_000);
    });

    it('keeps progressive retries bounded', () => {
        // Given
        const currentTimeoutMs = 480_000;

        // When
        const timeoutMs = nextProviderChunkTimeoutMs(currentTimeoutMs);

        // Then
        expect(timeoutMs).toBe(600_000);
    });
});
