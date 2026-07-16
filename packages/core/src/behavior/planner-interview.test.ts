import { describe, expect, it } from 'vitest';
import {
    detectInterviewForce,
    INTERVIEW_FORCE_MARKERS,
    PLANNER_MAX_INTERVIEW_TURNS,
    routeInterview,
} from './planner-interview';

describe('routeInterview', () => {
    it('returns cap_adopt when turns >= 6 (default max)', () => {
        // Given / When / Then
        expect(routeInterview({ turns: 6, clearance: false })).toBe('cap_adopt');
        expect(routeInterview({ turns: 7, clearance: true })).toBe('cap_adopt');
        expect(routeInterview({ turns: PLANNER_MAX_INTERVIEW_TURNS, clearance: false })).toBe(
            'cap_adopt',
        );
    });

    it('returns clear when clearance is true and under max turns', () => {
        expect(routeInterview({ turns: 0, clearance: true })).toBe('clear');
        expect(routeInterview({ turns: 5, clearance: true })).toBe('clear');
    });

    it('returns continue when clearance is false and turns < 6', () => {
        expect(routeInterview({ turns: 0, clearance: false })).toBe('continue');
        expect(routeInterview({ turns: 5, clearance: false })).toBe('continue');
    });

    it('keeps continue when forceInterview is true and clearance is false', () => {
        expect(
            routeInterview({ turns: 2, clearance: false, forceInterview: true }),
        ).toBe('continue');
    });

    it('returns clear when forceInterview is true and clearance is true', () => {
        expect(
            routeInterview({ turns: 2, clearance: true, forceInterview: true }),
        ).toBe('clear');
    });

    it('honors custom maxTurns', () => {
        expect(routeInterview({ turns: 3, clearance: false, maxTurns: 3 })).toBe('cap_adopt');
        expect(routeInterview({ turns: 2, clearance: false, maxTurns: 3 })).toBe('continue');
    });
});

describe('detectInterviewForce', () => {
    it('detects each INTERVIEW_FORCE_MARKERS entry case-insensitively', () => {
        for (const marker of INTERVIEW_FORCE_MARKERS) {
            expect(detectInterviewForce(marker)).toBe(true);
            expect(detectInterviewForce(marker.toUpperCase())).toBe(true);
            expect(detectInterviewForce(`please ${marker} now`)).toBe(true);
        }
    });

    it('returns false when no marker is present', () => {
        expect(detectInterviewForce('plan the auth rewrite')).toBe(false);
        expect(detectInterviewForce('')).toBe(false);
    });
});
