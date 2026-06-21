import { Box, Text } from 'ink';
import { useSyncExternalStore } from 'react';
import type { AbgOverlayState, AbgOverlayStore } from '../commands/abg-overlay-state.js';
import { DEFAULT_REFRESH_MS } from '../commands/abg-overlay-state.js';
import { GraphPane, NodesPane, OverviewPane } from './AbgOverlayPanesA.js';
import { ApprovalsPane, BlackboardPane, CostPolicyPane, TimelinePane, ToolsPane } from './AbgOverlayPanesB.js';

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

function statusColor(graphStatus: AbgOverlayState['graphStatus']): string {
    switch (graphStatus) {
        case 'active':
            return 'yellow';
        case 'completed':
            return 'green';
        case 'failed':
            return 'red';
        case 'cancelled':
            return 'gray';
        default:
            return 'dim';
    }
}

function truncateGraphId(graphId: string | undefined, maxLen: number = 20): string {
    if (graphId === undefined) return '(no graph)';
    if (graphId.length <= maxLen) return graphId;
    return `${graphId.slice(0, maxLen - 1)}…`;
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
}): React.ReactElement {
    const fps = Math.round(1000 / refreshMs);
    return (
        <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">
                <Text bold>{truncateGraphId(state.activeGraphId)}</Text>
                <Text> </Text>
                <Text color={statusColor(state.graphStatus)} bold>
                    [{state.graphStatus ?? 'idle'}]
                </Text>
                <Text> </Text>
                <Text dimColor>{state.runState}</Text>
            </Box>
            <Box flexDirection="row">
                <Text dimColor>{modelLabel}</Text>
                <Text> </Text>
                <Text dimColor>sidecar:{state.nativeSidecarStatus || 'unknown'}</Text>
                <Text> </Text>
                <Text dimColor>{formatCostSummary(state)}</Text>
                <Text> </Text>
                <Text dimColor>{fps}fps</Text>
            </Box>
        </Box>
    );
}

function TabStrip({ activeTab }: { activeTab: AbgOverlayTab }): React.ReactElement {
    return (
        <Box flexDirection="row">
            {TABS.map((tab, index) => {
                const isActive = tab === activeTab;
                const label = TAB_LABELS[tab];
                return (
                    <Box key={tab} flexDirection="row">
                        {index > 0 ? <Text dimColor> | </Text> : null}
                        {isActive ? (
                            <Text color="cyan" bold>
                                {label}
                            </Text>
                        ) : (
                            <Text dimColor>{label}</Text>
                        )}
                    </Box>
                );
            })}
        </Box>
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
}): React.ReactElement {
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
                <Box flexDirection="column" marginTop={1}>
                    <Text dimColor>(unknown pane)</Text>
                </Box>
            );
    }
}

function FooterHint({ narrow }: { narrow: boolean }): React.ReactElement {
    if (narrow) {
        return (
            <Box marginTop={1}>
                <Text color="yellow">Terminal too narrow for full overlay — widen to ≥100 cols for all panes</Text>
            </Box>
        );
    }
    return (
        <Box marginTop={1}>
            <Text dimColor>1-8 tabs | Tab cycle | ↑↓ scroll | g cycle graph | Ctrl+G/Esc close | r refresh | t live | c clear</Text>
        </Box>
    );
}

export function AbgOverlay({
    store,
    activeTab,
    scrollOffset: _scrollOffset,
    modelLabel,
    refreshMs = DEFAULT_REFRESH_MS,
}: AbgOverlayProps): React.ReactElement {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const cols = process.stdout.columns ?? 80;
    const narrow = shouldCollapseToOverview(cols);

    if (narrow) {
        return (
            <Box flexDirection="column">
                <Header state={state} modelLabel={modelLabel} refreshMs={refreshMs} />
                <TabStrip activeTab="overview" />
                <PaneBody activeTab="overview" state={state} modelLabel={modelLabel} />
                <FooterHint narrow={true} />
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Header state={state} modelLabel={modelLabel} refreshMs={refreshMs} />
            <TabStrip activeTab={activeTab} />
            <PaneBody activeTab={activeTab} state={state} modelLabel={modelLabel} />
            <FooterHint narrow={false} />
        </Box>
    );
}
