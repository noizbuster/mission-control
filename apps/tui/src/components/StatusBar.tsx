/** @jsxImportSource @opentui/solid */

import { terminalDisplayWidth } from '@mission-control/tui';
import { TextAttributes } from '@opentui/core';
import type { JSX } from 'solid-js';
import type { ApprovalLevel } from '../state/approval-level';
import { type BottomDockPolicy, type BottomDockStatusPolicy, bottomDockPolicy } from './chat-bottom-dock-policy';
import { CHAT_ERROR, CHAT_TEXT_MUTED, CHAT_WARNING } from './chat-theme';
import { APPROVAL_LEVEL_COLORS, STATUS_LINE_BG } from './overlay-theme';
import { basename } from 'node:path';

export type StatusBarLayout = {
    readonly columns: BottomDockPolicy['columns'];
    readonly status: Pick<BottomDockStatusPolicy, 'showContextUsage' | 'showProject' | 'showSession'>;
};

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
    readonly contextCacheInputTokens?: number;
    readonly contextCacheReadTokens?: number;
    readonly onCopySessionID?: () => void;
    readonly statusLayout?: StatusBarLayout;
};

/** Structured view of the top status line (pure, for unit tests + render). */
export type TopStatusShape = {
    readonly provider: string;
    readonly model: string;
    readonly variant: string | undefined;
    readonly contextLabel: string | undefined;
    readonly cacheHitLabel: string | undefined;
};

/** Structured view of the bottom status line (pure, for unit tests + render). */
export type BottomStatusShape = {
    readonly approvalLabel: string;
    readonly approvalColor: string | undefined;
    readonly projectLabel: string | undefined;
    readonly sessionLabel: string | undefined;
};

export type TopStatusRowShape = TopStatusShape & {
    readonly variantLabel: string | undefined;
    readonly contextGlyph: string | undefined;
    readonly leftText: string;
    readonly fillCount: number;
};

export type BottomStatusRowShape = BottomStatusShape & { readonly dimApproval: boolean; readonly fillCount: number };

const STATUS_DIVIDER = '-';

export function statusBarLayoutFromPolicy(policy: Pick<BottomDockPolicy, 'columns' | 'status'>): StatusBarLayout {
    return {
        columns: policy.columns,
        status: {
            showContextUsage: policy.status.showContextUsage,
            showProject: policy.status.showProject,
            showSession: policy.status.showSession,
        },
    };
}

export const DEFAULT_STATUS_BAR_LAYOUT: StatusBarLayout = statusBarLayoutFromPolicy(
    bottomDockPolicy({ columns: 80, rows: 24 }),
);

function resolveStatusBarLayout(props: StatusBarProps): StatusBarLayout {
    return props.statusLayout ?? DEFAULT_STATUS_BAR_LAYOUT;
}

function statusRowFillCount({
    columns,
    leftText,
    rightSegments,
}: {
    readonly columns: number;
    readonly leftText: string;
    readonly rightSegments: readonly string[];
}): number {
    const rightLength = rightSegments.reduce((total, segment) => total + terminalDisplayWidth(segment) + 1, 0);
    return Math.max(0, columns - terminalDisplayWidth(leftText) - 1 - rightLength - 1);
}

export function buildStatusDivider(fillCount: number): string {
    return STATUS_DIVIDER.repeat(fillCount);
}

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

/**
 * Whole-number fill percent for the context segment. Returns `undefined` when
 * the max is unknown or non-positive so the caller can omit the suffix.
 * Values above 100% are kept (context can exceed a configured soft limit).
 */
export function contextUsagePercent(used: number, max: number): number | undefined {
    if (!(max > 0) || !Number.isFinite(max) || !Number.isFinite(used) || used < 0) {
        return undefined;
    }
    return Math.round((used / max) * 100);
}

/** Color ramp for context fill: muted <70%, warning 70-89%, error >=90%. */
export function contextUsageColor(used: number, max: number): string | undefined {
    const percent = contextUsagePercent(used, max);
    if (percent === undefined) return undefined;
    if (percent >= 90) return CHAT_ERROR;
    if (percent >= 70) return CHAT_WARNING;
    return CHAT_TEXT_MUTED;
}

/** Single-cell pressure marker when the full context label is policy-hidden. */
export function contextPressureGlyph(used: number, max: number): string | undefined {
    const percent = contextUsagePercent(used, max);
    if (percent === undefined || percent < 70) return undefined;
    return percent >= 90 ? '●' : '○';
}

/** Whole-number cache-read percentage for a session's model-request input tokens. */
export function contextCacheHitPercent(cacheReadTokens: number, inputTokens: number): number | undefined {
    if (
        !(inputTokens > 0) ||
        !Number.isFinite(inputTokens) ||
        !Number.isFinite(cacheReadTokens) ||
        cacheReadTokens < 0 ||
        cacheReadTokens > inputTokens
    ) {
        return undefined;
    }
    return Math.round((cacheReadTokens / inputTokens) * 100);
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
    let cacheHitLabel: string | undefined;
    if (props.contextCacheInputTokens !== undefined && props.contextCacheReadTokens !== undefined) {
        const percent = contextCacheHitPercent(props.contextCacheReadTokens, props.contextCacheInputTokens);
        cacheHitLabel = percent === undefined ? undefined : `cache ${percent}%`;
    }
    let contextLabel: string | undefined;
    if (props.contextTokensMax !== undefined) {
        const used = props.contextTokensUsed ?? 0;
        const usedLabel = humanizeTokens(used);
        const maxLabel = humanizeTokens(props.contextTokensMax);
        const percent = contextUsagePercent(used, props.contextTokensMax);
        contextLabel =
            percent === undefined ? `${usedLabel} / ${maxLabel}` : `${usedLabel} / ${maxLabel} (${percent}%)`;
    }
    return {
        provider: props.providerID,
        model: props.modelID,
        variant: props.variantID,
        cacheHitLabel,
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

export function formatTopStatusRow(props: StatusBarProps): TopStatusRowShape {
    const layout = resolveStatusBarLayout(props);
    const { provider, model, variant, cacheHitLabel, contextLabel: rawContextLabel } = formatTopStatus(props);
    const variantLabel = variant?.replace(/^(reasoning|thinking)-/, '');
    const contextLabel = layout.status.showContextUsage ? rawContextLabel : undefined;
    const used = props.contextTokensUsed ?? 0;
    const max = props.contextTokensMax;
    // Narrow terminals hide the full "12k / 200k (6%)" label, but still surface
    // a single-cell pressure glyph once fill crosses the warning threshold.
    const contextGlyph =
        contextLabel === undefined && max !== undefined ? contextPressureGlyph(used, max) : undefined;
    const leftText = `${provider} ${model}${variantLabel !== undefined ? ` - ${variantLabel}` : ''}${
        cacheHitLabel !== undefined ? ` · ${cacheHitLabel}` : ''
    }`;
    const rightSegments =
        contextLabel !== undefined ? [contextLabel] : contextGlyph !== undefined ? [contextGlyph] : [];
    return {
        provider,
        model,
        variant,
        variantLabel,
        cacheHitLabel,
        contextLabel,
        contextGlyph,
        leftText,
        fillCount: statusRowFillCount({ columns: layout.columns, leftText, rightSegments }),
    };
}

export function formatBottomStatusRow(props: StatusBarProps): BottomStatusRowShape {
    const layout = resolveStatusBarLayout(props);
    const {
        approvalLabel,
        approvalColor,
        projectLabel: rawProjectLabel,
        sessionLabel: rawSessionLabel,
    } = formatBottomStatus(props);
    const projectLabel = layout.status.showProject ? rawProjectLabel : undefined;
    const sessionLabel = layout.status.showSession ? rawSessionLabel : undefined;
    const rightSegments = [projectLabel, sessionLabel].filter((segment): segment is string => segment !== undefined);
    return {
        approvalLabel,
        approvalColor,
        projectLabel,
        sessionLabel,
        dimApproval: props.approvalLevel === undefined || props.approvalLevel === 'verbose',
        fillCount: statusRowFillCount({ columns: layout.columns, leftText: approvalLabel, rightSegments }),
    };
}

/**
 * Top status line: provider (dim) + model (bold) + ` - ` variant (default) on
 * the left; policy-visible humanized context usage on the right. The gap
 * between the segments is filled with a dim divider so the line
 * reads as a continuous divider. Full-width dark-navy bg.
 */
export function TopStatusBar(props: StatusBarProps): JSX.Element {
    const row = () => formatTopStatusRow(props);
    return (
        <box backgroundColor={STATUS_LINE_BG} flexDirection="row" flexShrink={0} width="100%">
            <text selectable>
                <span style={{ dim: true }}>{row().provider}</span> <span style={{ bold: true }}>{row().model}</span>
                {row().variantLabel !== undefined ? ` - ${row().variantLabel}` : null}
                {row().cacheHitLabel !== undefined ? (
                    <span style={{ dim: true }}>{` · ${row().cacheHitLabel}`}</span>
                ) : null}
            </text>
            <text selectable> </text>
            <text selectable attributes={TextAttributes.DIM}>
                {buildStatusDivider(row().fillCount)}
            </text>
            {row().contextLabel !== undefined || row().contextGlyph !== undefined ? (
                <text
                    selectable
                    {...(() => {
                        const used = props.contextTokensUsed ?? 0;
                        const max = props.contextTokensMax;
                        const color =
                            max === undefined ? undefined : contextUsageColor(used, max);
                        return color !== undefined ? { fg: color } : {};
                    })()}
                >{` ${row().contextLabel ?? row().contextGlyph ?? ''}`}</text>
            ) : null}
        </box>
    );
}

/**
 * Bottom status line: approval indicator (colored by ramp; verbose and unknown
 * are dimmed) on the left; `project:branch(worktree)` followed by the raw
 * session id on the right (each segment omitted when absent). The session
 * segment always shows the durable session id; the human-readable title
 * (Ctrl+R / `/rename`) does not appear here. The gap between the segments is
 * filled with a dim divider. Full-width dark-navy bg.
 */
export function BottomStatusBar(props: StatusBarProps): JSX.Element {
    const row = () => formatBottomStatusRow(props);
    return (
        <box backgroundColor={STATUS_LINE_BG} flexDirection="row" flexShrink={0} width="100%">
            <text
                selectable
                {...(() => {
                    const color = row().approvalColor;
                    return color !== undefined ? { fg: color } : {};
                })()}
                {...(row().dimApproval ? { attributes: TextAttributes.DIM } : {})}
            >
                {row().approvalLabel}
            </text>
            <text selectable> </text>
            <text selectable attributes={TextAttributes.DIM}>
                {buildStatusDivider(row().fillCount)}
            </text>
            {row().projectLabel !== undefined ? <text selectable>{` ${row().projectLabel}`}</text> : null}
            {row().sessionLabel !== undefined ? (
                <text selectable {...(props.onCopySessionID !== undefined ? { onMouseUp: props.onCopySessionID } : {})}>
                    {` ${row().sessionLabel}`}
                </text>
            ) : null}
        </box>
    );
}
