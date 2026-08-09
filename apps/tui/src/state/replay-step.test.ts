import { describe, expect, it } from 'vitest';
import { planReplayStep } from './replay-step';

describe('planReplayStep', () => {
    it('applies only the new suffix when seeking forward', () => {
        expect(
            planReplayStep({
                cursor: 2,
                target: 5,
                envelopeCount: 8,
            }),
        ).toEqual({ cursor: 5, reset: false, startIndex: 2 });
    });

    it('rebuilds from the baseline when seeking backward', () => {
        expect(
            planReplayStep({
                cursor: 6,
                target: 3,
                envelopeCount: 8,
            }),
        ).toEqual({ cursor: 3, reset: true, startIndex: 0 });
    });

    it('clamps malformed cursors and targets to the replay bounds', () => {
        expect(
            planReplayStep({
                cursor: 99,
                target: -4,
                envelopeCount: 3,
            }),
        ).toEqual({ cursor: 0, reset: true, startIndex: 0 });
    });
});
