import { describe, expect, it } from 'vitest';
import { APPROVAL_LEVELS, type ApprovalLevel } from '../state/approval-level.js';
import { bottomDockPolicy } from './chat-bottom-dock-policy.js';
import {
    approvalLevelColor,
    buildStatusDivider,
    formatBottomStatus,
    formatBottomStatusRow,
    formatTopStatus,
    formatTopStatusRow,
    humanizeTokens,
    type StatusBarProps,
    statusBarLayoutFromPolicy,
} from './StatusBar.js';

const baseProps: StatusBarProps = { providerID: 'local', modelID: 'local-echo' };

function statusLayoutForColumns(columns: number) {
    return statusBarLayoutFromPolicy(bottomDockPolicy({ columns, rows: 24 }));
}

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

    it('builds `project:branch(worktree)` when workspace, branch, and worktree are all present', () => {
        const out = formatBottomStatus({
            ...baseProps,
            workspaceRoot: '/home/user/mission-control',
            gitBranch: 'feature-x',
            isWorktree: true,
        });
        expect(out.projectLabel).toBe('mission-control:feature-x(worktree)');
    });

    it('drops the worktree suffix for a normal checkout', () => {
        const out = formatBottomStatus({
            ...baseProps,
            workspaceRoot: '/home/user/mission-control',
            gitBranch: 'feature-x',
            isWorktree: false,
        });
        expect(out.projectLabel).toBe('mission-control:feature-x');
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
        expect(out.projectLabel).toBe('mission-control(worktree)');
    });

    it('omits the whole right segment when no workspace is known', () => {
        const out = formatBottomStatus({ ...baseProps, gitBranch: 'main' });
        expect(out.projectLabel).toBe(undefined);
    });

    it('falls back to the full path when basename is empty (root path)', () => {
        const out = formatBottomStatus({ ...baseProps, workspaceRoot: '/' });
        expect(out.projectLabel).toBe('/');
    });

    it('surfaces the raw session id when provided', () => {
        const out = formatBottomStatus({ ...baseProps, sessionID: 'session_abc123' });
        expect(out.sessionLabel).toBe('session_abc123');
    });

    it('leaves the session id undefined when not provided', () => {
        const out = formatBottomStatus(baseProps);
        expect(out.sessionLabel).toBe(undefined);
    });
});

describe('status divider rendering', () => {
    it('uses a single-column ASCII divider for long fillers', () => {
        // Given: a filler long enough to cover wide terminal status rows.
        const fillCount = 103;

        // When: the status divider is built for rendering.
        const divider = buildStatusDivider(fillCount);

        // Then: it avoids multi-byte box drawing glyphs that can fragment in OpenTUI captures.
        expect(divider).toBe('-'.repeat(fillCount));
        expect(divider).not.toContain('\u2500');
    });
});

describe('policy-derived status rows', () => {
    it('hides optional context, project, and session segments at narrow widths', () => {
        // Given: complete status data but a narrow policy layout.
        const statusLayout = statusLayoutForColumns(65);
        const props: StatusBarProps = {
            ...baseProps,
            statusLayout,
            contextTokensUsed: 12345,
            contextTokensMax: 200000,
            workspaceRoot: '/home/user/mission-control',
            gitBranch: 'feature-x',
            sessionID: 'session_abc123',
            approvalLevel: 'safe',
        };

        // When: both row models are formatted from the policy-derived layout.
        const top = formatTopStatusRow(props);
        const bottom = formatBottomStatusRow(props);

        // Then: required segments remain, optional segments hide, and filler stays non-negative.
        expect(top.provider).toBe('local');
        expect(top.model).toBe('local-echo');
        expect(top.contextLabel).toBe(undefined);
        expect(top.fillCount).toBeGreaterThanOrEqual(0);
        expect(bottom.approvalLabel).toBe('safe');
        expect(bottom.projectLabel).toBe(undefined);
        expect(bottom.sessionLabel).toBe(undefined);
        expect(bottom.fillCount).toBeGreaterThanOrEqual(0);
    });

    it('shows context usage, project, and session at 80 columns', () => {
        // Given: the normal-width policy threshold and complete status data.
        const statusLayout = statusLayoutForColumns(80);
        const props: StatusBarProps = {
            ...baseProps,
            statusLayout,
            contextTokensUsed: 12345,
            contextTokensMax: 200000,
            workspaceRoot: '/home/user/mission-control',
            gitBranch: 'feature-x',
            sessionID: 'session_abc123',
        };

        // When: both status rows are formatted.
        const top = formatTopStatusRow(props);
        const bottom = formatBottomStatusRow(props);

        // Then: context/project/session follow the >=80 policy gate.
        expect(top.contextLabel).toBe('12.3k / 200k');
        expect(bottom.projectLabel).toBe('mission-control:feature-x');
        expect(bottom.sessionLabel).toBe('session_abc123');
        expect(top.fillCount).toBeGreaterThanOrEqual(0);
        expect(bottom.fillCount).toBeGreaterThanOrEqual(0);
    });

    it('shows session at 120 columns', () => {
        // Given: the wide policy threshold and a durable session id.
        const statusLayout = statusLayoutForColumns(120);
        const props: StatusBarProps = {
            ...baseProps,
            statusLayout,
            workspaceRoot: '/home/user/mission-control',
            sessionID: 'session_abc123',
        };

        // When: the bottom row is formatted.
        const bottom = formatBottomStatusRow(props);

        // Then: project and session are both visible at the >=120 policy gate.
        expect(bottom.projectLabel).toBe('mission-control');
        expect(bottom.sessionLabel).toBe('session_abc123');
        expect(bottom.fillCount).toBeGreaterThanOrEqual(0);
    });

    it('never produces negative filler for long project and session labels', () => {
        // Given: visible project/session gates at normal width with labels longer than the available row width.
        const statusLayout = statusLayoutForColumns(80);
        const longSessionID = `session_${'x'.repeat(80)}`;
        const props: StatusBarProps = {
            ...baseProps,
            statusLayout,
            workspaceRoot: '/home/user/mission-control-with-a-very-long-worktree-name',
            gitBranch: 'feature-with-a-very-long-branch-name',
            isWorktree: true,
            sessionID: longSessionID,
        };

        // When: the bottom row computes filler against the normal-width policy.
        const bottom = formatBottomStatusRow(props);

        // Then: both labels stay visible, but the filler clamps to zero instead of underflowing.
        expect(bottom.projectLabel).toBe(
            'mission-control-with-a-very-long-worktree-name:feature-with-a-very-long-branch-name(worktree)',
        );
        expect(bottom.sessionLabel).toBe(longSessionID);
        expect(bottom.fillCount).toBe(0);
    });
});
