import { describe, expect, it } from 'vitest';
import {
    describeRetryableFailure,
    formatNodeRetryStatus,
    formatNodeWorkingStatus,
    formatThinkingStatus,
} from './interactive-coding-graph-status';

describe('describeRetryableFailure', () => {
    it('treats provider_rate_limited as retryable with overload label', () => {
        expect(
            describeRetryableFailure({
                code: 'provider_rate_limited',
                message: 'The service may be temporarily overloaded, please try again later',
                retryable: false,
            }),
        ).toEqual({
            retryable: true,
            shortReason: 'temporary overload',
        });
    });
});

describe('formatNodeRetryStatus', () => {
    it('formats attempt progress for intent-gate overload', () => {
        expect(
            formatNodeRetryStatus({
                nodeId: 'intent-gate',
                shortReason: 'temporary overload',
                attempt: 1,
                maxAttempts: 3,
            }),
        ).toBe('Classifying intent hit temporary overload — retrying (1/3)…');
    });
});

describe('formatNodeWorkingStatus', () => {
    it('shows attempt number after the first try', () => {
        expect(formatNodeWorkingStatus('intent-gate', 2)).toBe('Classifying intent (attempt 2)…');
        expect(formatNodeWorkingStatus('intent-gate')).toBe('Classifying intent…');
    });
});

describe('formatThinkingStatus', () => {
    it('includes known node labels and falls back for unknown nodes', () => {
        expect(formatThinkingStatus('intent-gate')).toBe('Thinking… (Classifying intent)');
        expect(formatThinkingStatus()).toBe('Thinking…');
        expect(formatThinkingStatus('custom-node-x')).toBe('Thinking…');
    });
});
