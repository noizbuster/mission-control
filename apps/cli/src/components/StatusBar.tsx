/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import type { ApprovalLevel } from '../commands/approval-level.js';
import { APPROVAL_LEVEL_COLORS, STATUS_LINE_BG } from './overlay-theme.js';
import { basename } from 'node:path';

export type StatusBarProps = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
    readonly sessionDisplayName?: string;
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
};

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
 * `mission-control - feature-x (worktree)`. `undefined` when no workspace is
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
        label = `${label} - ${gitBranch}`;
    }
    if (isWorktree) {
        label = `${label} (worktree)`;
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
    const leftText = `${provider} ${model}${variant !== undefined ? ` - ${variant}` : ''}`;
    const fillCount = Math.max(
        0,
        statusRowColumns() - leftText.length - 1 - (contextLabel !== undefined ? contextLabel.length + 1 : 0),
    );
    return (
        <box backgroundColor={STATUS_LINE_BG} flexDirection="row">
            <text>
                <span attributes={TextAttributes.DIM}>{provider}</span>{' '}
                <span attributes={TextAttributes.BOLD}>{model}</span>
                {variant !== undefined ? ` - ${variant}` : null}
            </text>
            <text>{' '}</text>
            <text attributes={TextAttributes.DIM}>{'\u2500'.repeat(fillCount)}</text>
            {contextLabel !== undefined ? <text>{` ${contextLabel}`}</text> : null}
        </box>
    );
}

/**
 * Bottom status line: approval indicator (colored by ramp; verbose and unknown
 * are dimmed) on the left; `project - branch (worktree)` on the right. The gap
 * between the segments is filled with a dim horizontal rule (`─`). Full-width
 * dark-navy bg.
 */
export function BottomStatusBar(props: StatusBarProps): React.ReactNode {
    const { approvalLabel, approvalColor, projectLabel } = formatBottomStatus(props);
    const dimApproval = props.approvalLevel === undefined || props.approvalLevel === 'verbose';
    const fillCount = Math.max(
        0,
        statusRowColumns() - approvalLabel.length - 1 - (projectLabel !== undefined ? projectLabel.length + 1 : 0),
    );
    return (
        <box backgroundColor={STATUS_LINE_BG} flexDirection="row">
            <text
                {...(approvalColor !== undefined ? { fg: approvalColor } : {})}
                {...(dimApproval ? { attributes: TextAttributes.DIM } : {})}
            >
                {approvalLabel}
            </text>
            <text>{' '}</text>
            <text attributes={TextAttributes.DIM}>{'\u2500'.repeat(fillCount)}</text>
            {projectLabel !== undefined ? <text>{` ${projectLabel}`}</text> : null}
        </box>
    );
}
