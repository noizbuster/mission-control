import { describe, expect, it } from 'vitest';
import {
    BOTTOM_DOCK_HEIGHT_POLICY,
    BOTTOM_DOCK_WIDTH_BREAKPOINTS,
    bottomDockPolicy,
} from './chat-bottom-dock-policy.js';

describe('bottom dock responsive constants', () => {
    it('pins the approved width breakpoints', () => {
        expect(BOTTOM_DOCK_WIDTH_BREAKPOINTS).toEqual({
            commandHint: 66,
            normal: 80,
            wide: 120,
            spacious: 150,
        });
    });

    it('pins the minimum height reservation and menu caps', () => {
        expect(BOTTOM_DOCK_HEIGHT_POLICY).toEqual({
            minTranscriptRows: 4,
            statusRows: 2,
            inputRows: 1,
            maxMenuRows: {
                narrow: 3,
                compact: 4,
                normal: 5,
                wide: 8,
                spacious: 10,
            },
        });
    });
});

describe('bottomDockPolicy breakpoints', () => {
    const breakpointCases = [
        {
            columns: 40,
            widthClass: 'narrow',
            showCommandHint: false,
            showContextUsage: false,
            showProject: false,
            showSession: false,
            showPanelFooter: false,
            menuRows: 3,
        },
        {
            columns: 65,
            widthClass: 'narrow',
            showCommandHint: false,
            showContextUsage: false,
            showProject: false,
            showSession: false,
            showPanelFooter: false,
            menuRows: 3,
        },
        {
            columns: 66,
            widthClass: 'compact',
            showCommandHint: true,
            showContextUsage: false,
            showProject: false,
            showSession: false,
            showPanelFooter: true,
            menuRows: 4,
        },
        {
            columns: 79,
            widthClass: 'compact',
            showCommandHint: true,
            showContextUsage: false,
            showProject: false,
            showSession: false,
            showPanelFooter: true,
            menuRows: 4,
        },
        {
            columns: 80,
            widthClass: 'normal',
            showCommandHint: true,
            showContextUsage: true,
            showProject: true,
            showSession: false,
            showPanelFooter: true,
            menuRows: 5,
        },
        {
            columns: 119,
            widthClass: 'normal',
            showCommandHint: true,
            showContextUsage: true,
            showProject: true,
            showSession: false,
            showPanelFooter: true,
            menuRows: 5,
        },
        {
            columns: 120,
            widthClass: 'wide',
            showCommandHint: true,
            showContextUsage: true,
            showProject: true,
            showSession: true,
            showPanelFooter: true,
            menuRows: 8,
        },
        {
            columns: 149,
            widthClass: 'wide',
            showCommandHint: true,
            showContextUsage: true,
            showProject: true,
            showSession: true,
            showPanelFooter: true,
            menuRows: 8,
        },
        {
            columns: 150,
            widthClass: 'spacious',
            showCommandHint: true,
            showContextUsage: true,
            showProject: true,
            showSession: true,
            showPanelFooter: true,
            menuRows: 10,
        },
    ] as const;

    it.each(breakpointCases)('maps $columns columns to $widthClass dock decisions', (expected) => {
        // Given: a 24-row terminal at a breakpoint edge.
        // When: the pure policy is evaluated.
        const policy = bottomDockPolicy({ columns: expected.columns, rows: 24 });

        // Then: status visibility and prompt-adjacent menu budget follow the approved breakpoint table.
        expect(policy.columns).toBe(expected.columns);
        expect(policy.rows).toBe(24);
        expect(policy.widthClass).toBe(expected.widthClass);
        expect(policy.status.showCommandHint).toBe(expected.showCommandHint);
        expect(policy.status.showContextUsage).toBe(expected.showContextUsage);
        expect(policy.status.showProject).toBe(expected.showProject);
        expect(policy.status.showSession).toBe(expected.showSession);
        expect(policy.menu.showPanelFooter).toBe(expected.showPanelFooter);
        expect(policy.menu.rows).toBe(expected.menuRows);
        expect(policy.status.rows).toBe(2);
        expect(policy.input.rows).toBe(1);
        expect(policy.transcript.rows).toBeGreaterThanOrEqual(4);
        expect(policy.transcript.rows + policy.menu.rows + policy.status.rows + policy.input.rows).toBe(policy.rows);
    });
});

describe('bottomDockPolicy height reservation', () => {
    const heightCases = [
        { rows: 6, effectiveRows: 7, menuRows: 0, transcriptRows: 4 },
        { rows: 10, effectiveRows: 10, menuRows: 3, transcriptRows: 4 },
        { rows: 24, effectiveRows: 24, menuRows: 10, transcriptRows: 11 },
    ] as const;

    it.each(heightCases)('keeps non-negative regions at $rows rows', (expected) => {
        // Given: a terminal height that may be smaller than the dock reservation.
        // When: the policy computes the bottom dock budget.
        const policy = bottomDockPolicy({ columns: 150, rows: expected.rows });

        // Then: fixed rows are reserved, menu rows never go negative, and transcript keeps at least four rows.
        expect(policy.rows).toBe(expected.effectiveRows);
        expect(policy.status.rows).toBe(2);
        expect(policy.input.rows).toBe(1);
        expect(policy.menu.rows).toBe(expected.menuRows);
        expect(policy.transcript.rows).toBe(expected.transcriptRows);
        expect(policy.menu.rows).toBeGreaterThanOrEqual(0);
        expect(policy.status.rows).toBeGreaterThanOrEqual(0);
        expect(policy.transcript.rows).toBeGreaterThanOrEqual(4);
        expect(policy.transcript.rows + policy.menu.rows + policy.status.rows + policy.input.rows).toBe(policy.rows);
    });
});

describe('bottomDockPolicy input clamping', () => {
    it('clamps invalid dimensions instead of throwing', () => {
        // Given: malformed terminal dimensions from an untrusted caller.
        // When: the pure policy evaluates them.
        const policy = bottomDockPolicy({ columns: -1, rows: -1 });

        // Then: invalid columns become narrow zero-width and rows rise to the minimum dock reservation.
        expect(policy).toEqual({
            columns: 0,
            rows: 7,
            widthClass: 'narrow',
            status: {
                rows: 2,
                showCommandHint: false,
                showContextUsage: false,
                showProject: false,
                showSession: false,
            },
            menu: {
                rows: 0,
                showPanelFooter: false,
            },
            input: {
                rows: 1,
            },
            transcript: {
                rows: 4,
            },
        });
    });

    it('returns deterministic decisions for the same dimensions', () => {
        // Given: the same valid terminal dimensions twice.
        const input = { columns: 120, rows: 24 };

        // When: the pure policy is evaluated repeatedly.
        const first = bottomDockPolicy(input);
        const second = bottomDockPolicy(input);

        // Then: results are value-identical and do not depend on terminal globals.
        expect(second).toEqual(first);
    });
});
