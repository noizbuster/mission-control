import { describe, expect, it } from 'vitest';
import { APPROVAL_LEVELS, type ApprovalLevel } from '../commands/approval-level.js';
import {
    approvalLevelColor,
    formatBottomStatus,
    formatTopStatus,
    humanizeTokens,
    type StatusBarProps,
} from './StatusBar.js';

const baseProps: StatusBarProps = { providerID: 'local', modelID: 'local-echo' };

describe('humanizeTokens', () => {
    it('preserves undefined so the caller can hide the segment', () => {
        expect(humanizeTokens(undefined)).toBe(undefined);
    });

    it('renders sub-1000 counts verbatim', () => {
        expect(humanizeTokens(0)).toBe('0');
        expect(humanizeTokens(999)).toBe('999');
    });

    it('renders thousands with one decimal (plan acceptance pin)', () => {
        expect(humanizeTokens(12345)).toBe('12.3k');
    });

    it('drops a trailing .0 so round numbers read cleanly', () => {
        expect(humanizeTokens(1000)).toBe('1k');
        expect(humanizeTokens(200000)).toBe('200k');
    });

    it('renders millions with one decimal', () => {
        expect(humanizeTokens(1_500_000)).toBe('1.5M');
        expect(humanizeTokens(2_000_000)).toBe('2M');
    });
});

describe('approvalLevelColor', () => {
    it('maps every level onto its ramp color', () => {
        const expected: Record<ApprovalLevel, string> = {
            verbose: '#888888',
            safe: '#26d926',
            aggressive: '#d9d926',
            reckless: '#d98526',
            yolo: '#d92626',
        };
        for (const level of APPROVAL_LEVELS) {
            expect(approvalLevelColor(level)).toBe(expected[level]);
        }
    });

    it('returns undefined for an unknown level (no throw)', () => {
        expect(approvalLevelColor(undefined)).toBe(undefined);
    });
});

describe('formatTopStatus', () => {
    it('surfaces provider, model, and variant', () => {
        const out = formatTopStatus({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variantID: 'thinking-high',
        });
        expect(out).toEqual({
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            variant: 'thinking-high',
            contextLabel: undefined,
        });
    });

    it('leaves variant undefined when none is selected', () => {
        const out = formatTopStatus(baseProps);
        expect(out.variant).toBe(undefined);
    });

    it('omits the context segment when the max is unknown', () => {
        const out = formatTopStatus({ ...baseProps, contextTokensUsed: 12345 });
        expect(out.contextLabel).toBe(undefined);
    });

    it('humanizes used / max when the max is known', () => {
        const out = formatTopStatus({
            ...baseProps,
            contextTokensUsed: 12345,
            contextTokensMax: 200000,
        });
        expect(out.contextLabel).toBe('12.3k / 200k');
    });

    it('shows 0 used before the first turn rather than undefined', () => {
        const out = formatTopStatus({ ...baseProps, contextTokensMax: 200000 });
        expect(out.contextLabel).toBe('0 / 200k');
    });
});

describe('formatBottomStatus', () => {
    it('labels the segment with the active level and its ramp color', () => {
        const out = formatBottomStatus({ ...baseProps, approvalLevel: 'aggressive' });
        expect(out.approvalLabel).toBe('aggressive');
        expect(out.approvalColor).toBe('#d9d926');
    });

    it('falls back to a generic label and undefined color when no level is set', () => {
        const out = formatBottomStatus(baseProps);
        expect(out.approvalLabel).toBe('approval');
        expect(out.approvalColor).toBe(undefined);
    });

    it('builds `project - branch (worktree)` when workspace, branch, and worktree are all present', () => {
        const out = formatBottomStatus({
            ...baseProps,
            workspaceRoot: '/home/user/mission-control',
            gitBranch: 'feature-x',
            isWorktree: true,
        });
        expect(out.projectLabel).toBe('mission-control - feature-x (worktree)');
    });

    it('drops the worktree suffix for a normal checkout', () => {
        const out = formatBottomStatus({
            ...baseProps,
            workspaceRoot: '/home/user/mission-control',
            gitBranch: 'feature-x',
            isWorktree: false,
        });
        expect(out.projectLabel).toBe('mission-control - feature-x');
    });

    it('shows just the project dir when no branch is known', () => {
        const out = formatBottomStatus({
            ...baseProps,
            workspaceRoot: '/home/user/mission-control/',
        });
        expect(out.projectLabel).toBe('mission-control');
    });

    it('appends the worktree suffix even without a branch', () => {
        const out = formatBottomStatus({
            ...baseProps,
            workspaceRoot: '/home/user/mission-control',
            isWorktree: true,
        });
        expect(out.projectLabel).toBe('mission-control (worktree)');
    });

    it('omits the whole right segment when no workspace is known', () => {
        const out = formatBottomStatus({ ...baseProps, gitBranch: 'main' });
        expect(out.projectLabel).toBe(undefined);
    });

    it('falls back to the full path when basename is empty (root path)', () => {
        const out = formatBottomStatus({ ...baseProps, workspaceRoot: '/' });
        expect(out.projectLabel).toBe('/');
    });
});
