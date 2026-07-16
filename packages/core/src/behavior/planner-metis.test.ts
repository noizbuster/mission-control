import { describe, expect, it } from 'vitest';
import {
    METIS_REJECT_ROUTE_VALUES,
    PLANNER_METIS_REJECT_BUDGET,
    routeMetisReject,
} from './planner-metis';

describe('routeMetisReject', () => {
    it('returns revise when rejects is strictly below the default budget of 1', () => {
        // Given / When / Then
        expect(routeMetisReject(0)).toBe('revise');
        expect(routeMetisReject(0, PLANNER_METIS_REJECT_BUDGET)).toBe('revise');
    });

    it('returns escalate_present when rejects is at or above the default budget', () => {
        expect(routeMetisReject(1)).toBe('escalate_present');
        expect(routeMetisReject(2)).toBe('escalate_present');
        expect(routeMetisReject(PLANNER_METIS_REJECT_BUDGET)).toBe('escalate_present');
    });

    it('defaults budget to PLANNER_METIS_REJECT_BUDGET (1)', () => {
        expect(PLANNER_METIS_REJECT_BUDGET).toBe(1);
        expect(routeMetisReject(0)).toBe(routeMetisReject(0, 1));
        expect(routeMetisReject(1)).toBe(routeMetisReject(1, 1));
    });

    it('honors a custom budget', () => {
        expect(routeMetisReject(0, 2)).toBe('revise');
        expect(routeMetisReject(1, 2)).toBe('revise');
        expect(routeMetisReject(2, 2)).toBe('escalate_present');
        expect(routeMetisReject(3, 2)).toBe('escalate_present');
    });

    it('exports the equals-routed vocabulary revise | escalate_present', () => {
        expect(METIS_REJECT_ROUTE_VALUES).toEqual(['revise', 'escalate_present']);
    });
});
