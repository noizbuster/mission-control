/** @jsxImportSource @opentui/react */
import type React from 'react';
import type { AbgOverlayState } from '../commands/abg-overlay-state.js';
import { toOpenTuiAttributes, toOpenTuiColor } from '../platform/opentui-types.js';
import { useSpinnerFrame } from './spinner.js';
import { renderVisualGraph, type VisualGraphEdge, type VisualGraphNode, type VisualGraphRow } from './visual-graph.js';

export interface PaneProps {
    readonly state: AbgOverlayState;
    readonly modelLabel: string;
}

const dimAttrs = toOpenTuiAttributes({ dimColor: true });
const boldAttrs = toOpenTuiAttributes({ bold: true });

function statusColorFg(status: string | undefined): string | undefined {
    switch (status) {
        case 'running':
            return toOpenTuiColor('yellow');
        case 'succeeded':
        case 'active':
            return toOpenTuiColor('green');
        case 'failed':
            return toOpenTuiColor('red');
        case 'blocked':
            return toOpenTuiColor('cyan');
        case 'cancelled':
            return toOpenTuiColor('gray');
        default:
            return undefined;
    }
}

function graphStatusFg(graphStatus: AbgOverlayState['graphStatus']): string {
    switch (graphStatus) {
        case 'active':
            return toOpenTuiColor('yellow') ?? '#ffff00';
        case 'completed':
            return toOpenTuiColor('green') ?? '#00ff00';
        case 'failed':
            return toOpenTuiColor('red') ?? '#ff0000';
        case 'blocked':
            return toOpenTuiColor('cyan') ?? '#00ffff';
        case 'cancelled':
            return toOpenTuiColor('gray') ?? '#808080';
        default:
            return toOpenTuiColor('dim') ?? '#808080';
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

const cyanFg = toOpenTuiColor('cyan');
const yellowFg = toOpenTuiColor('yellow');
const redFg = toOpenTuiColor('red');
const focusedStyle = cyanFg !== undefined ? { fg: cyanFg, bold: true } : { bold: true };

export function OverviewPane({ state, modelLabel }: PaneProps): React.ReactNode {
    if (isEmptyState(state)) {
        return (
            <box flexDirection="column" marginTop={1}>
                <text {...dimAttrs}>No active ABG run</text>
            </box>
        );
    }

    const graphId = state.focusedGraphId ?? state.activeGraphId ?? '(no graph)';
    const statusFgVal = graphStatusFg(state.graphStatus);
    const statusText = state.graphStatus ?? 'idle';

    const liveOutputLines = state.lastLiveDelta.split('\n').slice(-8);
    const knownGraphs = [...state.graphs.values()].sort((left, right) => left.graphId.localeCompare(right.graphId));

    return (
        <box flexDirection="column" marginTop={1}>
            <box flexDirection="row">
                <text {...boldAttrs}>{truncate(graphId, 20)}</text>
                <text> </text>
                <text {...(statusFgVal !== undefined ? { fg: statusFgVal } : {})} {...boldAttrs}>
                    [{statusText}]
                </text>
                <text> </text>
                <text {...dimAttrs}>{state.runState}</text>
                <text> </text>
                <text {...dimAttrs}>{modelLabel}</text>
                <text> </text>
                <text {...dimAttrs}>sidecar:{state.nativeSidecarStatus || 'unknown'}</text>
                <text> </text>
                <text {...dimAttrs}>{formatCostSummary(state)}</text>
            </box>
            {knownGraphs.length > 1 ? (
                <box marginTop={1} flexDirection="column">
                    <box flexDirection="row">
                        <text {...boldAttrs}>{`Graphs (${knownGraphs.length})  `}</text>
                        <text {...dimAttrs}>press 'g' to cycle focus</text>
                    </box>
                    {knownGraphs.map((summary) => {
                        const isFocused = summary.graphId === state.focusedGraphId;
                        const color = graphStatusFg(summary.status);
                        const graphFg = color !== toOpenTuiColor('dim') ? color : undefined;
                        return (
                            <box key={summary.graphId} flexDirection="row">
                                <text {...(isFocused ? focusedStyle : dimAttrs)}>
                                    {isFocused ? '▸ ' : '  '}
                                </text>
                                <text {...(graphFg !== undefined ? { fg: graphFg } : dimAttrs)}>{summary.status}</text>
                                <text> </text>
                                <text {...(isFocused ? boldAttrs : {})}>{truncate(summary.graphId, 30)}</text>
                                <text {...dimAttrs}> events={summary.eventCount}</text>
                                {summary.parentGraphId !== undefined ? (
                                    <text {...dimAttrs}> ← {truncate(summary.parentGraphId, 20)}</text>
                                ) : null}
                            </box>
                        );
                    })}
                </box>
            ) : null}
            {state.lastError !== undefined ? (
                <box marginTop={1}>
                    <text {...(redFg !== undefined ? { fg: redFg } : {})}>Error: {state.lastError}</text>
                </box>
            ) : null}
            <box flexDirection="column" marginTop={1}>
                <text {...boldAttrs}>Live Output:</text>
                {liveOutputLines.map((line: string, idx: number) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: live output lines are append-only
                    <text key={idx} {...dimAttrs}>
                        {line}
                    </text>
                ))}
            </box>
        </box>
    );
}

function renderVisualRow(row: VisualGraphRow, idx: number, spinnerGlyph: string): React.ReactNode {
    if (row.kind === 'connector') {
        const text = row.segments.map((segment) => segment.text).join('');
        return (
            <text key={`vis-${idx}`} {...dimAttrs}>
                {text}
            </text>
        );
    }
    return (
        <box key={`vis-${idx}`} flexDirection="row">
            {row.segments.map((segment, segIdx) => {
                const fg = statusColorFg(segment.status);
                return (
                    <text
                        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable per node row
                        key={`seg-${segIdx}`}
                        {...(fg !== undefined ? { fg } : dimAttrs)}
                    >
                        {segment.text}
                    </text>
                );
            })}
            {row.isActive ? <text {...(yellowFg !== undefined ? { fg: yellowFg } : {})}> {spinnerGlyph}</text> : null}
        </box>
    );
}

export function GraphPane({ state }: PaneProps): React.ReactNode {
    const { glyph: spinnerGlyph } = useSpinnerFrame();
    if (isEmptyState(state)) {
        return (
            <box flexDirection="column" marginTop={1}>
                <text {...dimAttrs}>No active ABG run</text>
            </box>
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
    const visualEdges: VisualGraphEdge[] = state.graphEdges.map((edge) => ({
        from: edge.source,
        to: edge.target,
        ...(edge.condition !== undefined ? { label: edge.condition } : {}),
    }));
    const visual = renderVisualGraph({ nodes: visualNodes, edges: visualEdges });

    return (
        <box flexDirection="column" marginTop={1}>
            <text {...boldAttrs}>{graphId}</text>
            {!visual.collapsed ? (
                <box flexDirection="column" marginLeft={2}>
                    {visual.rows.map((row, idx) => renderVisualRow(row, idx, spinnerGlyph))}
                </box>
            ) : (
                <box flexDirection="column">
                    <text {...dimAttrs}>(graph too wide — adjacency list)</text>
                    {nodes.length === 0 ? (
                        <box flexDirection="row" marginLeft={2}>
                            <text {...dimAttrs}>(no nodes)</text>
                        </box>
                    ) : (
                        nodes.map(([nodeId, status]) => {
                            const fg = statusColorFg(status);
                            const glyph = statusGlyph(status);
                            const outgoing = state.graphEdges.filter((e) => e.source === nodeId);
                            return (
                                <box key={nodeId} flexDirection="column" marginLeft={2}>
                                    <box flexDirection="row">
                                        <text {...(fg !== undefined ? { fg } : dimAttrs)}>{glyph}</text>
                                        <text> </text>
                                        <text>{nodeId}</text>
                                        <text {...dimAttrs}> ({status})</text>
                                    </box>
                                    {outgoing.map((edge) => (
                                        <box
                                            key={`${nodeId}-${edge.source}-${edge.target}`}
                                            flexDirection="row"
                                            marginLeft={4}
                                        >
                                            <text {...dimAttrs}>└→</text>
                                            <text {...dimAttrs}> {edge.target}</text>
                                            {edge.condition !== undefined ? (
                                                <text {...dimAttrs}> [{truncate(edge.condition, 24)}]</text>
                                            ) : null}
                                        </box>
                                    ))}
                                </box>
                            );
                        })
                    )}
                </box>
            )}
            {childGraphs.length > 0 ? (
                <box marginTop={1} flexDirection="column">
                    <text {...boldAttrs} {...dimAttrs}>
                        Child Graphs ({childGraphs.length})
                    </text>
                    {childGraphs.map((child) => {
                        const color = graphStatusFg(child.status);
                        const childFg = color !== toOpenTuiColor('dim') ? color : undefined;
                        return (
                            <box key={child.graphId} flexDirection="row" marginLeft={2}>
                                <text {...dimAttrs}>↳</text>
                                <text> </text>
                                <text {...(childFg !== undefined ? { fg: childFg } : dimAttrs)}>{child.status}</text>
                                <text> </text>
                                <text>{truncate(child.graphId, 30)}</text>
                                <text {...dimAttrs}> events={child.eventCount}</text>
                            </box>
                        );
                    })}
                </box>
            ) : null}
        </box>
    );
}

export function NodesPane({ state }: PaneProps): React.ReactNode {
    if (isEmptyState(state)) {
        return (
            <box flexDirection="column" marginTop={1}>
                <text {...dimAttrs}>No active ABG run</text>
            </box>
        );
    }

    const nodes = [...state.nodes.entries()];

    return (
        <box flexDirection="column" marginTop={1}>
            <box flexDirection="row">
                <text {...boldAttrs}>ID</text>
                <text> </text>
                <text {...boldAttrs}>Status</text>
            </box>
            {nodes.length === 0 ? (
                <box flexDirection="row">
                    <text {...dimAttrs}>(no nodes)</text>
                </box>
            ) : (
                nodes.map(([nodeId, status]) => {
                    const fg = statusColorFg(status);
                    const glyph = statusGlyph(status);
                    return (
                        <box key={nodeId} flexDirection="row">
                            <text {...(fg !== undefined ? { fg } : dimAttrs)}>{glyph}</text>
                            <text> </text>
                            <text>{truncate(nodeId, 10)}</text>
                            <text> </text>
                            <text {...(fg !== undefined ? { fg } : dimAttrs)}>[{status}]</text>
                        </box>
                    );
                })
            )}
        </box>
    );
}
