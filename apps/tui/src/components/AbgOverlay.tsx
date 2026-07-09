/** @jsxImportSource @opentui/solid */

import { truncateTerminalText } from '@mission-control/tui';
import { For, type JSX } from 'solid-js';
import type { TerminalViewport } from '../platform/terminal-viewport.js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector.js';
import type { AbgOverlayState, AbgOverlayStore } from '../state/abg-overlay-state.js';
import { DEFAULT_REFRESH_MS } from '../state/abg-overlay-state.js';
import { GraphPane, NodesPane, OverviewPane } from './AbgOverlayPanesA.js';
import { ApprovalsPane, BlackboardPane, CostPolicyPane, TimelinePane, ToolsPane } from './AbgOverlayPanesB.js';
import { graphStatusTheme, STATUS_FG_GRAY } from './abg-status-theme.js';

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
 * mounting the terminal renderer — do NOT inline back into the component.
 */
export function shouldCollapseToOverview(cols: number): boolean {
    return cols < NARROW_THRESHOLD;
}

export function shouldCollapseViewportToOverview(viewport: Pick<TerminalViewport, 'columns'>): boolean {
    return shouldCollapseToOverview(viewport.columns);
}

export function visibleAbgOverlayTab(
    activeTab: AbgOverlayTab,
    viewport: Pick<TerminalViewport, 'columns'>,
): AbgOverlayTab {
    return shouldCollapseViewportToOverview(viewport) ? 'overview' : activeTab;
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
    readonly viewport: TerminalViewport;
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
}): JSX.Element {
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

function TabStrip({ activeTab }: { activeTab: AbgOverlayTab }): JSX.Element {
    return (
        <box flexDirection="row">
            <For each={TABS}>
                {(tab, index) => {
                    const isActive = tab === activeTab;
                    const label = TAB_LABELS[tab];
                    return (
                        <box flexDirection="row">
                            {index() > 0 ? <text {...dimAttrs}> | </text> : null}
                            {isActive ? (
                                <text {...(cyanFg !== undefined ? { fg: cyanFg } : {})} {...boldAttrs}>
                                    {label}
                                </text>
                            ) : (
                                <text {...dimAttrs}>{label}</text>
                            )}
                        </box>
                    );
                }}
            </For>
        </box>
    );
}

function PaneBody({
    activeTab,
    state,
    modelLabel,
    viewport,
}: {
    activeTab: AbgOverlayTab;
    state: AbgOverlayState;
    modelLabel: string;
    viewport: TerminalViewport;
}): JSX.Element {
    switch (activeTab) {
        case 'overview':
            return <OverviewPane state={state} modelLabel={modelLabel} />;
        case 'graph':
            return <GraphPane state={state} modelLabel={modelLabel} viewport={viewport} />;
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

function FooterHint({ narrow }: { narrow: boolean }): JSX.Element {
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

export function AbgOverlay(props: AbgOverlayProps): JSX.Element {
    const state = useSolidStoreSelector(props.store, (snapshot) => snapshot);
    const refreshMs = () => props.refreshMs ?? DEFAULT_REFRESH_MS;
    const narrow = () => shouldCollapseViewportToOverview(props.viewport);
    const visibleTab = () => visibleAbgOverlayTab(props.activeTab, props.viewport);

    return (
        <box flexDirection="column" height="100%" shouldFill={true}>
            <Header state={state()} modelLabel={props.modelLabel} refreshMs={refreshMs()} />
            <TabStrip activeTab={visibleTab()} />
            <box flexGrow={1} shouldFill={true}>
                <PaneBody
                    activeTab={visibleTab()}
                    state={state()}
                    modelLabel={props.modelLabel}
                    viewport={props.viewport}
                />
            </box>
            <FooterHint narrow={narrow()} />
        </box>
    );
}
