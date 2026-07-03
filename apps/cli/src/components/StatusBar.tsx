/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import type { ApprovalLevel } from '../commands/approval-level.js';
import { terminalDisplayWidth } from '../commands/terminal-text.js';
import { APPROVAL_LEVEL_COLORS, STATUS_LINE_BG } from './overlay-theme.js';
import { basename } from 'node:path';

export type StatusBarProps = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
    readonly workspaceRoot?: string;
    readonly gitBranch?: string;
    readonly isWorktree?: boolean;
    readonly approvalLevel?: ApprovalLevel;
    readonly contextTokensUsed?: number;
    readonly contextTokensMax?: number;
};

/** Structured view of the top status line (pure, for unit tests + render). */
export type TopStatusShape = {
    readonly provider: string;
    readonly model: string;
    readonly variant: string | undefined;
    readonly contextLabel: string | undefined;
};

/** Structured view of the bottom status line (pure, for unit tests + render). */
export type BottomStatusShape = {
    readonly approvalLabel: string;
    readonly approvalColor: string | undefined;
    readonly projectLabel: string | undefined;
    readonly sessionLabel: string | undefined;
};

/**
 * Render label for the bottom-right session segment. The status bar always
 * shows the durable session id; the human-readable title (set via Ctrl+R or
 * `/rename`) lives only in the rename overlay and the durable metadata event.
 */
export function buildSessionLabel(sessionID: string | undefined): string | undefined {
    return sessionID;
}

/**
 * Humanize a token count for compact status display. `undefined` is preserved
 * (the caller hides the whole segment when the max is unknown). Round numbers
 * drop the trailing `.0` so `200000` renders as `200k`, not `200.0k`.
 */
export function humanizeTokens(n: number | undefined): string | undefined {
    if (n === undefined) {
        return undefined;
    }
    if (n < 1000) {
        return String(n);
    }
    const divisor = n >= 1_000_000 ? 1_000_000 : 1000;
    const suffix = n >= 1_000_000 ? 'M' : 'k';
    const formatted = (n / divisor).toFixed(1);
    const trimmed = formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
    return `${trimmed}${suffix}`;
}

/** Resolve the ramp color for an approval level; `undefined` for an unknown level. */
export function approvalLevelColor(level: ApprovalLevel | undefined): string | undefined {
    if (level === undefined) {
        return undefined;
    }
    return APPROVAL_LEVEL_COLORS[level];
}

/**
 * Project / branch / worktree label for the bottom-right segment, e.g.
 * `mission-control:feature-x(worktree)`. `undefined` when no workspace is
 * known (the segment is omitted entirely).
 */
function buildProjectLabel(
    workspaceRoot: string | undefined,
    gitBranch: string | undefined,
    isWorktree: boolean | undefined,
): string | undefined {
    if (workspaceRoot === undefined) {
        return undefined;
    }
    const dirLabel = basename(workspaceRoot) || workspaceRoot;
    let label = dirLabel;
    if (gitBranch !== undefined && gitBranch.length > 0) {
        label = `${label}:${gitBranch}`;
    }
    if (isWorktree) {
        label = `${label}(worktree)`;
    }
    return label;
}

/** Pure view-model for the top status line. The context segment hides unless the max is known. */
export function formatTopStatus(props: StatusBarProps): TopStatusShape {
    const contextLabel =
        props.contextTokensMax === undefined
            ? undefined
            : `${humanizeTokens(props.contextTokensUsed ?? 0)} / ${humanizeTokens(props.contextTokensMax)}`;
    return {
        provider: props.providerID,
        model: props.modelID,
        variant: props.variantID,
        contextLabel,
    };
}

/** Pure view-model for the bottom status line. */
export function formatBottomStatus(props: StatusBarProps): BottomStatusShape {
    return {
        approvalLabel: props.approvalLevel ?? 'approval',
        approvalColor: approvalLevelColor(props.approvalLevel),
        projectLabel: buildProjectLabel(props.workspaceRoot, props.gitBranch, props.isWorktree),
        sessionLabel: buildSessionLabel(props.sessionID),
    };
}

/**
 * Number of columns the row should fill. Matches the Separator component's
 * width source (`process.stdout.columns`, read at render time so a store
 * update after a resize recomputes the fill).
 */
function statusRowColumns(): number {
    return process.stdout.columns ?? 80;
}

/**
 * Top status line: provider (dim) + model (bold) + ` - ` variant (default) on
 * the left; humanized context usage on the right, omitted when the max is
 * unknown. The gap between the segments is filled with a dim horizontal rule
 * (`─`) so the line reads as a continuous divider. Full-width dark-navy bg.
 */
export function TopStatusBar(props: StatusBarProps): React.ReactNode {
    const { provider, model, variant, contextLabel } = formatTopStatus(props);
    const variantLabel = variant?.replace(/^(reasoning|thinking)-/, '');
    const leftText = `${provider} ${model}${variantLabel !== undefined ? ` - ${variantLabel}` : ''}`;
    const fillCount = Math.max(
        0,
        statusRowColumns() -
            terminalDisplayWidth(leftText) -
            1 -
            (contextLabel !== undefined ? terminalDisplayWidth(contextLabel) + 1 : 0),
    );
    return (
        <box backgroundColor={STATUS_LINE_BG} flexDirection="row" flexShrink={0}>
            <text>
                <span attributes={TextAttributes.DIM}>{provider}</span>{' '}
                <span attributes={TextAttributes.BOLD}>{model}</span>
                {variantLabel !== undefined ? ` - ${variantLabel}` : null}
            </text>
            <text> </text>
            <text attributes={TextAttributes.DIM}>{'\u2500'.repeat(fillCount)}</text>
            {contextLabel !== undefined ? <text>{` ${contextLabel}`}</text> : null}
        </box>
    );
}

/**
 * Bottom status line: approval indicator (colored by ramp; verbose and unknown
 * are dimmed) on the left; `project:branch(worktree)` followed by the raw
 * session id on the right (each segment omitted when absent). The session
 * segment always shows the durable session id; the human-readable title
 * (Ctrl+R / `/rename`) does not appear here. The gap between the segments is
 * filled with a dim horizontal rule (`─`). Full-width dark-navy bg.
 */
export function BottomStatusBar(props: StatusBarProps): React.ReactNode {
    const { approvalLabel, approvalColor, projectLabel, sessionLabel } = formatBottomStatus(props);
    const dimApproval = props.approvalLevel === undefined || props.approvalLevel === 'verbose';
    const rightLength =
        (projectLabel !== undefined ? terminalDisplayWidth(projectLabel) + 1 : 0) +
        (sessionLabel !== undefined ? terminalDisplayWidth(sessionLabel) + 1 : 0);
    const fillCount = Math.max(0, statusRowColumns() - terminalDisplayWidth(approvalLabel) - 1 - rightLength);
    return (
        <box backgroundColor={STATUS_LINE_BG} flexDirection="row" flexShrink={0}>
            <text
                {...(approvalColor !== undefined ? { fg: approvalColor } : {})}
                {...(dimApproval ? { attributes: TextAttributes.DIM } : {})}
            >
                {approvalLabel}
            </text>
            <text> </text>
            <text attributes={TextAttributes.DIM}>{'\u2500'.repeat(fillCount)}</text>
            {projectLabel !== undefined ? <text>{` ${projectLabel}`}</text> : null}
            {sessionLabel !== undefined ? <text>{` ${sessionLabel}`}</text> : null}
        </box>
    );
}
