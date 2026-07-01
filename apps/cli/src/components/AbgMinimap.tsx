/** @jsxImportSource @opentui/react */

import type { AbgNodeStatus } from '@mission-control/protocol';
import type * as React from 'react';
import { useSyncExternalStore } from 'react';
import type { AbgOverlayStore } from '../commands/abg-overlay-state.js';
import { nodeStatusTheme, STATUS_FG_GRAY } from './abg-status-theme.js';
import {
    renderVisualGraph,
    type VisualGraphEdge,
    type VisualGraphInput,
    type VisualGraphNode,
    type VisualGraphRow,
} from './visual-graph.js';

const MINIMAP_MAX_WIDTH = 22;
const MINIMAP_MAX_NODES = 6;
const PULSE_WINDOW_MS = 3000;

export interface AbgMinimapProps {
    readonly store: AbgOverlayStore;
}

function buildInput(
    nodes: ReadonlyMap<string, AbgNodeStatus>,
    edges: readonly { readonly source: string; readonly target: string; readonly condition?: string }[],
    activeNodeIds: readonly string[],
    activeGraphId: string | undefined,
): VisualGraphInput {
    const visualNodes: VisualGraphNode[] = [];
    for (const [nodeId, status] of nodes) {
        visualNodes.push({ nodeId, status, isActive: activeNodeIds.includes(nodeId) });
    }
    const visualEdges: VisualGraphEdge[] = edges.map((edge) => ({
        from: edge.source,
        to: edge.target,
        ...(edge.condition !== undefined ? { label: edge.condition } : {}),
    }));
    return {
        nodes: visualNodes,
        edges: visualEdges,
        ...(activeGraphId !== undefined ? { entryNodeId: activeGraphId } : {}),
        maxNodes: MINIMAP_MAX_NODES,
        maxWidth: MINIMAP_MAX_WIDTH,
    };
}

function computeRecentStatuses(
    nodeChangedAtMs: ReadonlyMap<string, number>,
    nodes: ReadonlyMap<string, AbgNodeStatus>,
    now: number,
): Set<AbgNodeStatus> {
    const result = new Set<AbgNodeStatus>();
    for (const [nodeId, changedAt] of nodeChangedAtMs) {
        if (now - changedAt < PULSE_WINDOW_MS) {
            const status = nodes.get(nodeId);
            if (status !== undefined) result.add(status);
        }
    }
    return result;
}

function renderRow(row: VisualGraphRow, recentStatuses: Set<AbgNodeStatus>): React.ReactNode {
    const firstText = row.segments[0]?.text ?? '';
    return (
        <box key={firstText} flexDirection="row" flexShrink={0}>
            {row.segments.map((segment) => {
                const theme = segment.status !== undefined ? nodeStatusTheme(segment.status) : undefined;
                const fg = theme?.foreground;
                const isRecent = segment.status !== undefined && recentStatuses.has(segment.status);
                return (
                    <text
                        key={segment.text}
                        {...(fg !== undefined ? { fg } : { fg: STATUS_FG_GRAY })}
                        {...(isRecent ? { bold: true } : {})}
                    >
                        {segment.text}
                    </text>
                );
            })}
        </box>
    );
}

export function AbgMinimap({ store }: AbgMinimapProps): React.ReactNode {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

    if (state.nodes.size === 0) return null;

    const input = buildInput(state.nodes, state.graphEdges, state.activeNodeIds, state.activeGraphId);
    const rendered = renderVisualGraph(input);
    const recentStatuses = computeRecentStatuses(state.nodeChangedAtMs, state.nodes, Date.now());

    return (
        <box
            position="absolute"
            top={0}
            right={0}
            flexDirection="column"
            flexShrink={0}
            borderStyle="single"
            borderColor="#404040"
        >
            {rendered.rows.map((row) => renderRow(row, recentStatuses))}
        </box>
    );
}
