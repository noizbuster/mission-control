import { describe, expect, it } from 'vitest';
import { formatAgentRetryCountdown } from './agent-retry-countdown';

describe('formatAgentRetryCountdown', () => {
    it('shows whole seconds remaining and clears after the retry deadline', () => {
        expect(formatAgentRetryCountdown(15_001, 12_400)).toBe('Retrying in 3s');
        expect(formatAgentRetryCountdown(12_000, 12_400)).toBeUndefined();
    });
});
