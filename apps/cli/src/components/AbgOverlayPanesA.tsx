import { Box, Text } from 'ink';
import type { AbgOverlayState } from '../commands/abg-overlay-state.js';
import { renderVisualGraph, type VisualGraphEdge, type VisualGraphNode } from './visual-graph.js';

export interface PaneProps {
    readonly state: AbgOverlayState;
    readonly modelLabel: string;
}

function statusColor(status: string | undefined): string | undefined {
    switch (status) {
        case 'running':
            return 'yellow';
        case 'succeeded':
        case 'active':
            return 'green';
        case 'failed':
            return 'red';
        case 'blocked':
            return 'cyan';
        case 'cancelled':
            return 'gray';
        default:
            return undefined;
    }
}

function graphStatusColor(graphStatus: AbgOverlayState['graphStatus']): string {
    switch (graphStatus) {
        case 'active':
            return 'yellow';
        case 'completed':
            return 'green';
        case 'failed':
            return 'red';
        case 'blocked':
            return 'cyan';
        case 'cancelled':
            return 'gray';
        default:
            return 'dim';
    }
}

function statusGlyph(status: string | undefined): string {
    switch (status) {
        case 'running':
            return '▶';
        case 'succeeded':
            return '✓';
        case 'failed':
            return '✗';
        case 'blocked':
            return '⏸';
        case 'cancelled':
            return '⊘';
        default:
            return '○';
    }
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatCostSummary(state: AbgOverlayState): string {
    const cost = state.costCents !== undefined ? `$${(state.costCents / 100).toFixed(2)}` : '$0.00';
    return `${cost} / ${state.inputTokens} in / ${state.outputTokens} out`;
}

function isEmptyState(state: AbgOverlayState): boolean {
    return (
        state.activeGraphId === undefined ||
        state.graphStatus === undefined ||
        (state.nodes.size === 0 && state.recentEvents.length === 0)
    );
}

export function OverviewPane({ state, modelLabel }: PaneProps): React.ReactElement {
    if (isEmptyState(state)) {
        return (
            <Box flexDirection="column" marginTop={1}>
                <Text dimColor>No active ABG run</Text>
            </Box>
        );
    }

    const graphId = state.focusedGraphId ?? state.activeGraphId ?? '(no graph)';
    const statusColorValue = graphStatusColor(state.graphStatus);
    const statusText = state.graphStatus ?? 'idle';

    const liveOutputLines = state.lastLiveDelta.split('\n').slice(-8);
    const knownGraphs = [...state.graphs.values()].sort((left, right) => left.graphId.localeCompare(right.graphId));

    return (
        <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
                <Text bold>{truncate(graphId, 20)}</Text>
                <Text> </Text>
                <Text color={statusColorValue} bold>
                    [{statusText}]
                </Text>
                <Text> </Text>
                <Text dimColor>{state.runState}</Text>
                <Text> </Text>
                <Text dimColor>{modelLabel}</Text>
                <Text> </Text>
                <Text dimColor>sidecar:{state.nativeSidecarStatus || 'unknown'}</Text>
                <Text> </Text>
                <Text dimColor>{formatCostSummary(state)}</Text>
            </Box>
            {knownGraphs.length > 1 ? (
                <Box marginTop={1} flexDirection="column">
                    <Text bold>
                        Graphs ({knownGraphs.length}){'  '}
                        <Text dimColor>press 'g' to cycle focus</Text>
                    </Text>
                    {knownGraphs.map((summary) => {
                        const isFocused = summary.graphId === state.focusedGraphId;
                        const color = graphStatusColor(summary.status);
                        return (
                            <Box key={summary.graphId} flexDirection="row">
                                <Text {...(isFocused ? { color: 'cyan', bold: true } : { dimColor: true })}>
                                    {isFocused ? '▸ ' : '  '}
                                </Text>
                                <Text {...(color !== 'dim' ? { color } : { dimColor: true })}>{summary.status}</Text>
                                <Text> </Text>
                                <Text {...(isFocused ? { bold: true } : {})}>{truncate(summary.graphId, 30)}</Text>
                                <Text dimColor> events={summary.eventCount}</Text>
                                {summary.parentGraphId !== undefined ? (
                                    <Text dimColor> ← {truncate(summary.parentGraphId, 20)}</Text>
                                ) : null}
                            </Box>
                        );
                    })}
                </Box>
            ) : null}
            {state.lastError !== undefined ? (
                <Box marginTop={1}>
                    <Text color="red">Error: {state.lastError}</Text>
                </Box>
            ) : null}
            <Box flexDirection="column" marginTop={1}>
                <Text bold>Live Output:</Text>
                {liveOutputLines.map((line: string, idx: number) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: live output lines are append-only
                    <Text key={idx} dimColor>
                        {line}
                    </Text>
                ))}
            </Box>
        </Box>
    );
}

export function GraphPane({ state }: PaneProps): React.ReactElement {
    if (isEmptyState(state)) {
        return (
            <Box flexDirection="column" marginTop={1}>
                <Text dimColor>No active ABG run</Text>
            </Box>
        );
    }

    const graphId = state.focusedGraphId ?? state.activeGraphId ?? '(no graph)';
    const nodes = [...state.nodes.entries()];
    const childGraphs = [...state.graphs.values()]
        .filter((summary) => summary.parentGraphId === graphId)
        .sort((left, right) => left.graphId.localeCompare(right.graphId));

    const visualNodes: VisualGraphNode[] = nodes.map(([nodeId, status]) => ({
        nodeId,
        status,
        isActive: state.activeNodeIds.includes(nodeId),
    }));
    // Infer linear edges between consecutive nodes when no explicit edges are available.
    const inferredEdges: VisualGraphEdge[] =
        visualNodes.length > 1
            ? visualNodes.slice(0, -1).map((node, idx) => {
                  const next = visualNodes[idx + 1];
                  return { from: node.nodeId, to: next?.nodeId ?? node.nodeId };
              })
            : [];
    const visual = renderVisualGraph({ nodes: visualNodes, edges: inferredEdges });

    return (
        <Box flexDirection="column" marginTop={1}>
            <Text bold>{graphId}</Text>
            {!visual.collapsed ? (
                <Box flexDirection="column" marginLeft={2}>
                    {visual.lines.map((line, idx) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: visual lines are stable per render
                        <Text key={`vis-${idx}`} dimColor>
                            {line}
                        </Text>
                    ))}
                </Box>
            ) : (
                <Box flexDirection="column">
                    <Text dimColor>(graph too wide — falling back to tree)</Text>
                    {nodes.length === 0 ? (
                        <Box flexDirection="row" marginLeft={2}>
                            <Text dimColor>(no nodes)</Text>
                        </Box>
                    ) : (
                        nodes.map(([nodeId, status]) => {
                            const color = statusColor(status);
                            const glyph = statusGlyph(status);
                            return (
                                <Box key={nodeId} flexDirection="row" marginLeft={2}>
                                    {color !== undefined ? (
                                        <Text color={color}>{glyph}</Text>
                                    ) : (
                                        <Text dimColor>{glyph}</Text>
                                    )}
                                    <Text> </Text>
                                    <Text>{nodeId}</Text>
                                    <Text dimColor> ({status})</Text>
                                </Box>
                            );
                        })
                    )}
                </Box>
            )}
            {childGraphs.length > 0 ? (
                <Box marginTop={1} flexDirection="column">
                    <Text bold dimColor>
                        Child Graphs ({childGraphs.length})
                    </Text>
                    {childGraphs.map((child) => {
                        const color = graphStatusColor(child.status);
                        return (
                            <Box key={child.graphId} flexDirection="row" marginLeft={2}>
                                <Text dimColor>↳</Text>
                                <Text> </Text>
                                <Text {...(color !== 'dim' ? { color } : { dimColor: true })}>{child.status}</Text>
                                <Text> </Text>
                                <Text>{truncate(child.graphId, 30)}</Text>
                                <Text dimColor> events={child.eventCount}</Text>
                            </Box>
                        );
                    })}
                </Box>
            ) : null}
        </Box>
    );
}

export function NodesPane({ state }: PaneProps): React.ReactElement {
    if (isEmptyState(state)) {
        return (
            <Box flexDirection="column" marginTop={1}>
                <Text dimColor>No active ABG run</Text>
            </Box>
        );
    }

    const nodes = [...state.nodes.entries()];

    return (
        <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
                <Text bold>ID</Text>
                <Text> </Text>
                <Text bold>Status</Text>
            </Box>
            {nodes.length === 0 ? (
                <Box flexDirection="row">
                    <Text dimColor>(no nodes)</Text>
                </Box>
            ) : (
                nodes.map(([nodeId, status]) => {
                    const color = statusColor(status);
                    return (
                        <Box key={nodeId} flexDirection="row">
                            <Text>{truncate(nodeId, 10)}</Text>
                            <Text> </Text>
                            {color !== undefined ? <Text color={color}>{status}</Text> : <Text dimColor>{status}</Text>}
                        </Box>
                    );
                })
            )}
        </Box>
    );
}
