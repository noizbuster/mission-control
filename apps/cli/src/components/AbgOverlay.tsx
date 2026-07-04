/** @jsxImportSource @opentui/react */
import { useSyncExternalStore } from 'react';
import type { AbgOverlayState, AbgOverlayStore } from '../commands/abg-overlay-state.js';
import { DEFAULT_REFRESH_MS } from '../commands/abg-overlay-state.js';
import { GraphPane, NodesPane, OverviewPane } from './AbgOverlayPanesA.js';
import { ApprovalsPane, BlackboardPane, CostPolicyPane, TimelinePane, ToolsPane } from './AbgOverlayPanesB.js';
import { graphStatusTheme, STATUS_FG_GRAY } from './abg-status-theme.js';
import { truncateTerminalText } from '../commands/terminal-text.js';

export type AbgOverlayTab =
    | 'overview'
    | 'graph'
    | 'nodes'
    | 'tools'
    | 'timeline'
    | 'approvals'
    | 'cost-policy'
    | 'blackboard';

const TABS: readonly AbgOverlayTab[] = [
    'overview',
    'graph',
    'nodes',
    'tools',
    'timeline',
    'approvals',
    'cost-policy',
    'blackboard',
];

/** Shared tab order so keyboard drivers map digits/cycle to the same tab rendered here (no drift). */
export const ABG_OVERLAY_TABS: readonly AbgOverlayTab[] = TABS;

/** Min terminal width (cols) for the full 8-tab layout (Metis 2.8). */
export const NARROW_THRESHOLD = 100;

/**
 * Pure collapse-decision. Extracted from the render path so resize behavior is testable without
 * `ink-testing-library` — do NOT inline back into the component.
 */
export function shouldCollapseToOverview(cols: number): boolean {
    return cols < NARROW_THRESHOLD;
}

const TAB_LABELS: Record<AbgOverlayTab, string> = {
    overview: 'Overview',
    graph: 'Graph',
    nodes: 'Nodes',
    tools: 'Tools',
    timeline: 'Timeline',
    approvals: 'Approvals',
    'cost-policy': 'Cost&Policy',
    blackboard: 'Blackboard',
};

export interface AbgOverlayProps {
    readonly store: AbgOverlayStore;
    readonly activeTab: AbgOverlayTab;
    readonly scrollOffset: number;
    readonly modelLabel: string;
    readonly refreshMs?: number;
}

const dimAttrs = { dim: true };
const boldAttrs = { bold: true };
const cyanFg = '#00ffff';
const yellowFg = '#ffff00';

function truncateGraphId(graphId: string | undefined, maxLen: number = 20): string {
    if (graphId === undefined) return '(no graph)';
    return truncateTerminalText(graphId, maxLen, '\u2026');
}

function formatCostSummary(state: AbgOverlayState): string {
    const cost = state.costCents !== undefined ? `$${(state.costCents / 100).toFixed(2)}` : '$0.00';
    return `${cost} / ${state.inputTokens} in / ${state.outputTokens} out`;
}

function Header({
    state,
    modelLabel,
    refreshMs,
}: {
    state: AbgOverlayState;
    modelLabel: string;
    refreshMs: number;
}): React.ReactNode {
    const fps = Math.round(1000 / refreshMs);
    // Preserve the pre-refactor default: an undefined graph status renders gray, not terminal-default.
    const statusFg = state.graphStatus !== undefined ? graphStatusTheme(state.graphStatus).foreground : STATUS_FG_GRAY;
    return (
        <box flexDirection="row" justifyContent="space-between">
            <box flexDirection="row">
                <text {...boldAttrs}>{truncateGraphId(state.activeGraphId)}</text>
                <text> </text>
                <text {...(statusFg !== undefined ? { fg: statusFg } : {})} {...boldAttrs}>
                    [{state.graphStatus ?? 'idle'}]
                </text>
                <text> </text>
                <text {...dimAttrs}>{state.runState}</text>
            </box>
            <box flexDirection="row">
                <text {...dimAttrs}>{modelLabel}</text>
                <text> </text>
                <text {...dimAttrs}>sidecar:{state.nativeSidecarStatus || 'unknown'}</text>
                <text> </text>
                <text {...dimAttrs}>{formatCostSummary(state)}</text>
                <text> </text>
                <text {...dimAttrs}>{fps}fps</text>
            </box>
        </box>
    );
}

function TabStrip({ activeTab }: { activeTab: AbgOverlayTab }): React.ReactNode {
    return (
        <box flexDirection="row">
            {TABS.map((tab, index) => {
                const isActive = tab === activeTab;
                const label = TAB_LABELS[tab];
                return (
                    <box key={tab} flexDirection="row">
                        {index > 0 ? <text {...dimAttrs}> | </text> : null}
                        {isActive ? (
                            <text {...(cyanFg !== undefined ? { fg: cyanFg } : {})} {...boldAttrs}>
                                {label}
                            </text>
                        ) : (
                            <text {...dimAttrs}>{label}</text>
                        )}
                    </box>
                );
            })}
        </box>
    );
}

function PaneBody({
    activeTab,
    state,
    modelLabel,
}: {
    activeTab: AbgOverlayTab;
    state: AbgOverlayState;
    modelLabel: string;
}): React.ReactNode {
    switch (activeTab) {
        case 'overview':
            return <OverviewPane state={state} modelLabel={modelLabel} />;
        case 'graph':
            return <GraphPane state={state} modelLabel={modelLabel} />;
        case 'nodes':
            return <NodesPane state={state} modelLabel={modelLabel} />;
        case 'tools':
            return <ToolsPane state={state} />;
        case 'timeline':
            return <TimelinePane state={state} />;
        case 'approvals':
            return <ApprovalsPane state={state} />;
        case 'cost-policy':
            return <CostPolicyPane state={state} modelLabel={modelLabel} />;
        case 'blackboard':
            return <BlackboardPane state={state} />;
        default:
            return (
                <box flexDirection="column" marginTop={1}>
                    <text {...dimAttrs}>(unknown pane)</text>
                </box>
            );
    }
}

function FooterHint({ narrow }: { narrow: boolean }): React.ReactNode {
    if (narrow) {
        return (
            <box marginTop={1}>
                <text {...(yellowFg !== undefined ? { fg: yellowFg } : {})}>
                    Terminal too narrow for full overlay — widen to ≥100 cols for all panes
                </text>
            </box>
        );
    }
    return (
        <box marginTop={1}>
            <text {...dimAttrs}>1-8 tabs | Tab cycle | ↑↓ scroll | r refresh | c clear | Ctrl+G/Esc close</text>
        </box>
    );
}

export function AbgOverlay({
    store,
    activeTab,
    scrollOffset: _scrollOffset,
    modelLabel,
    refreshMs = DEFAULT_REFRESH_MS,
}: AbgOverlayProps): React.ReactNode {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const cols = process.stdout.columns ?? 80;
    const narrow = shouldCollapseToOverview(cols);

    if (narrow) {
        return (
            <box flexDirection="column" height="100%" shouldFill={true}>
                <Header state={state} modelLabel={modelLabel} refreshMs={refreshMs} />
                <TabStrip activeTab="overview" />
                <box flexGrow={1} shouldFill={true}>
                    <PaneBody activeTab="overview" state={state} modelLabel={modelLabel} />
                </box>
                <FooterHint narrow={true} />
            </box>
        );
    }

    return (
        <box flexDirection="column" height="100%" shouldFill={true}>
            <Header state={state} modelLabel={modelLabel} refreshMs={refreshMs} />
            <TabStrip activeTab={activeTab} />
            <box flexGrow={1} shouldFill={true}>
                <PaneBody activeTab={activeTab} state={state} modelLabel={modelLabel} />
            </box>
            <FooterHint narrow={false} />
        </box>
    );
}
