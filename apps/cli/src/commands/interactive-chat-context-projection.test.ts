import { describe, expect, it } from 'vitest';
import { isLiveTurnUsageProjection, isSessionUsageProjectionLive } from './interactive-chat';

describe('isSessionUsageProjectionLive', () => {
    it('accepts callbacks for the still-attached turn session', () => {
        expect(
            isSessionUsageProjectionLive({
                expectedSessionId: 'session-current',
                currentSessionId: 'session-current',
                tuiSessionId: 'session-current',
                eventQueueClosed: false,
            }),
        ).toBe(true);
    });

    it('rejects every late callback from a session replaced by navigation', () => {
        expect(
            isSessionUsageProjectionLive({
                expectedSessionId: 'session-old',
                currentSessionId: 'session-new',
                tuiSessionId: 'session-new',
                eventQueueClosed: false,
            }),
        ).toBe(false);
    });

    it('rejects a callback when the TUI attaches a different session or closes', () => {
        expect(
            isSessionUsageProjectionLive({
                expectedSessionId: 'session-current',
                currentSessionId: 'session-current',
                tuiSessionId: 'session-other',
                eventQueueClosed: false,
            }),
        ).toBe(false);
        expect(
            isSessionUsageProjectionLive({
                expectedSessionId: undefined,
                currentSessionId: undefined,
                tuiSessionId: '',
                eventQueueClosed: true,
            }),
        ).toBe(false);
    });
});

describe('isLiveTurnUsageProjection', () => {
    it('rejects a late same-session provider completion after its turn is invalidated', () => {
        expect(
            isLiveTurnUsageProjection({
                expectedSessionId: 'session-current',
                currentSessionId: 'session-current',
                tuiSessionId: 'session-current',
                eventQueueClosed: false,
                expectedTurnEpoch: 4,
                currentTurnEpoch: 5,
            }),
        ).toBe(false);
    });

    it('accepts usage from the current live turn', () => {
        expect(
            isLiveTurnUsageProjection({
                expectedSessionId: 'session-current',
                currentSessionId: 'session-current',
                tuiSessionId: 'session-current',
                eventQueueClosed: false,
                expectedTurnEpoch: 5,
                currentTurnEpoch: 5,
            }),
        ).toBe(true);
    });
});
