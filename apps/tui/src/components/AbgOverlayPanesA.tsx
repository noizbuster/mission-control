/** @jsxImportSource @opentui/solid */

import { truncateTerminalText } from '@mission-control/tui';
import { For, type JSX, Show } from 'solid-js';
import type { AbgOverlayState } from '../state/abg-overlay-state';
import { sanitizeAbgDisplayText } from './abg-display-projection';
import { scrolledSlice } from './abg-scroll';
import { graphStatusTheme, nodeStatusTheme, STATUS_FG_GRAY } from './abg-status-theme';

export { GraphPane, type GraphPaneProps } from './AbgOverlayGraphPane';

export interface PaneProps {
    readonly state: AbgOverlayState;
    readonly modelLabel: string;
    readonly scrollOffset?: number;
}

const dimAttrs = { dim: true };
const boldAttrs = { bold: true };

function truncate(text: string, max: number): string {
    return truncateTerminalText(sanitizeAbgDisplayText(text), max, '\u2026');
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

const cyanFg = '#00ffff';
const redFg = '#ff0000';
const focusedStyle = { fg: cyanFg, bold: true };

export function OverviewPane(props: PaneProps): JSX.Element {
    const empty = () => isEmptyState(props.state);
    const graphId = () => props.state.focusedGraphId ?? props.state.activeGraphId ?? '(no graph)';
    const statusFgVal = () =>
        props.state.graphStatus !== undefined ? graphStatusTheme(props.state.graphStatus).foreground : STATUS_FG_GRAY;
    const statusText = () => props.state.graphStatus ?? 'idle';
    const liveOutputLines = () =>
        scrolledSlice(props.state.lastLiveDelta.split('\n').slice(-8), props.scrollOffset ?? 0).map(
            sanitizeAbgDisplayText,
        );
    const knownGraphs = () =>
        scrolledSlice(
            [...props.state.graphs.values()].sort((left, right) => left.graphId.localeCompare(right.graphId)),
            props.scrollOffset ?? 0,
        );
    const knownGraphCount = () => props.state.graphs.size;

    return (
        <Show
            when={!empty()}
            fallback={
                <box flexDirection="column" marginTop={1}>
                    <text {...dimAttrs}>No active ABG run</text>
                </box>
            }
        >
            <box flexDirection="column" marginTop={1}>
                <box flexDirection="row">
                    <text {...boldAttrs}>{truncate(graphId(), 20)}</text>
                    <text> </text>
                    <text {...(statusFgVal() !== undefined ? { fg: statusFgVal() } : {})} {...boldAttrs}>
                        [{statusText()}]
                    </text>
                    <text> </text>
                    <text {...dimAttrs}>{props.state.runState}</text>
                    <text> </text>
                    <text {...dimAttrs}>{sanitizeAbgDisplayText(props.modelLabel)}</text>
                    <text> </text>
                    <text {...dimAttrs}>
                        sidecar:{sanitizeAbgDisplayText(props.state.nativeSidecarStatus || 'unknown')}
                    </text>
                    <text> </text>
                    <text {...dimAttrs}>{formatCostSummary(props.state)}</text>
                </box>
                {knownGraphCount() > 1 ? (
                    <box marginTop={1} flexDirection="column">
                        <box flexDirection="row">
                            <text {...boldAttrs}>{`Graphs (${knownGraphCount()})  `}</text>
                            <text {...dimAttrs}>press 'g' to cycle focus</text>
                        </box>
                        <For each={knownGraphs()}>
                            {(summary) => {
                                const isFocused = () => summary.graphId === props.state.focusedGraphId;
                                const themeFg = graphStatusTheme(summary.status).foreground;
                                const graphFg = themeFg !== STATUS_FG_GRAY ? themeFg : undefined;
                                return (
                                    <box flexDirection="row">
                                        <text {...(isFocused() ? focusedStyle : dimAttrs)}>
                                            {isFocused() ? '▸ ' : '  '}
                                        </text>
                                        <text {...(graphFg !== undefined ? { fg: graphFg } : dimAttrs)}>
                                            {summary.status}
                                        </text>
                                        <text> </text>
                                        <text {...(isFocused() ? boldAttrs : {})}>{truncate(summary.graphId, 30)}</text>
                                        <text {...dimAttrs}> events={summary.eventCount}</text>
                                        {summary.parentGraphId !== undefined ? (
                                            <text {...dimAttrs}> ← {truncate(summary.parentGraphId, 20)}</text>
                                        ) : null}
                                    </box>
                                );
                            }}
                        </For>
                    </box>
                ) : null}
                {props.state.lastError !== undefined ? (
                    <box marginTop={1}>
                        <text {...(redFg !== undefined ? { fg: redFg } : {})}>
                            Error: {sanitizeAbgDisplayText(props.state.lastError)}
                        </text>
                    </box>
                ) : null}
                <box flexDirection="column" marginTop={1}>
                    <text {...boldAttrs}>Live Output:</text>
                    <For each={liveOutputLines()}>{(line) => <text {...dimAttrs}>{line}</text>}</For>
                </box>
            </box>
        </Show>
    );
}

export function NodesPane(props: PaneProps): JSX.Element {
    const empty = () => isEmptyState(props.state);
    const nodes = () => scrolledSlice([...props.state.nodes.entries()], props.scrollOffset ?? 0);
    const nodeCount = () => props.state.nodes.size;

    return (
        <Show
            when={!empty()}
            fallback={
                <box flexDirection="column" marginTop={1}>
                    <text {...dimAttrs}>No active ABG run</text>
                </box>
            }
        >
            <box flexDirection="column" marginTop={1}>
                <box flexDirection="row">
                    <text {...boldAttrs}>ID</text>
                    <text> </text>
                    <text {...boldAttrs}>Status</text>
                </box>
                {nodeCount() === 0 ? (
                    <box flexDirection="row">
                        <text {...dimAttrs}>(no nodes)</text>
                    </box>
                ) : (
                    <For each={nodes()}>
                        {([nodeId, status]) => {
                            const nodeTheme = nodeStatusTheme(status);
                            const fg = nodeTheme.foreground;
                            const glyph = nodeTheme.glyph;
                            return (
                                <box flexDirection="row">
                                    <text {...(fg !== undefined ? { fg } : dimAttrs)}>{glyph}</text>
                                    <text> </text>
                                    <text>{truncate(nodeId, 10)}</text>
                                    <text> </text>
                                    <text {...(fg !== undefined ? { fg } : dimAttrs)}>[{status}]</text>
                                </box>
                            );
                        }}
                    </For>
                )}
            </box>
        </Show>
    );
}
