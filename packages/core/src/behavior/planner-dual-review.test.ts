import { describe, expect, it } from 'vitest';
import {
    DUAL_FIX_ROUTE_VALUES,
    DUAL_ROUTE_VALUES,
    PLANNER_DUAL_FIX_BUDGET,
    routeDualReview,
    routeFixDual,
} from './planner-dual-review';

describe('routeDualReview', () => {
    it('returns skip when intent is clear and reviewRequired is false (both present)', () => {
        // Given / When / Then
        expect(routeDualReview({ intent: 'clear', reviewRequired: false })).toBe('skip');
    });

    it('returns run when reviewRequired is true even if intent is clear', () => {
        expect(routeDualReview({ intent: 'clear', reviewRequired: true })).toBe('run');
    });

    it('returns run when intent is unclear even if reviewRequired is false', () => {
        expect(routeDualReview({ intent: 'unclear', reviewRequired: false })).toBe('run');
    });

    it('returns run when intent is unclear and reviewRequired is true', () => {
        expect(routeDualReview({ intent: 'unclear', reviewRequired: true })).toBe('run');
    });

    it('fail-closes to run when intent is missing', () => {
        expect(routeDualReview({ intent: undefined, reviewRequired: false })).toBe('run');
        expect(routeDualReview({ intent: undefined, reviewRequired: true })).toBe('run');
    });

    it('fail-closes to run when reviewRequired is missing', () => {
        expect(routeDualReview({ intent: 'clear', reviewRequired: undefined })).toBe('run');
        expect(routeDualReview({ intent: 'unclear', reviewRequired: undefined })).toBe('run');
    });

    it('fail-closes to run when both keys are missing', () => {
        expect(routeDualReview({ intent: undefined, reviewRequired: undefined })).toBe('run');
    });

    it('returns run for non-clear intent labels when both keys are present', () => {
        expect(routeDualReview({ intent: 'on-the-fence', reviewRequired: false })).toBe('run');
        expect(routeDualReview({ intent: 'fresh', reviewRequired: false })).toBe('run');
    });

    it('exports the equals-routed vocabulary skip | run', () => {
        expect(DUAL_ROUTE_VALUES).toEqual(['skip', 'run']);
    });
});

describe('routeFixDual', () => {
    it('returns revise when fixes is strictly below the default budget of 1', () => {
        expect(routeFixDual(0)).toBe('revise');
        expect(routeFixDual(0, PLANNER_DUAL_FIX_BUDGET)).toBe('revise');
    });

    it('returns escalate when fixes is at or above the default budget', () => {
        expect(routeFixDual(1)).toBe('escalate');
        expect(routeFixDual(2)).toBe('escalate');
        expect(routeFixDual(PLANNER_DUAL_FIX_BUDGET)).toBe('escalate');
    });

    it('defaults budget to PLANNER_DUAL_FIX_BUDGET (1)', () => {
        expect(PLANNER_DUAL_FIX_BUDGET).toBe(1);
        expect(routeFixDual(0)).toBe(routeFixDual(0, 1));
        expect(routeFixDual(1)).toBe(routeFixDual(1, 1));
    });

    it('honors a custom budget', () => {
        expect(routeFixDual(0, 2)).toBe('revise');
        expect(routeFixDual(1, 2)).toBe('revise');
        expect(routeFixDual(2, 2)).toBe('escalate');
        expect(routeFixDual(3, 2)).toBe('escalate');
    });

    it('exports the equals-routed vocabulary revise | escalate', () => {
        expect(DUAL_FIX_ROUTE_VALUES).toEqual(['revise', 'escalate']);
    });
});
