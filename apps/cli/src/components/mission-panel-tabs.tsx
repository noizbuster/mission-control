/** @jsxImportSource @opentui/react */
import type { ContinuationState } from '@mission-control/core';
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import {
    type AgentPanelRow,
    agentStatusColor,
    buildContinuationPanelView,
    DRAIN_TAB_MESSAGE,
    type JobPanelRow,
    jobStatusColor,
} from './mission-panel-rows.js';
import { SELECTED_BG } from './overlay-theme.js';

const MISSION_PANEL_MAX_VISIBLE = 12;

type WindowedView = {
    readonly startIndex: number;
    readonly visibleCount: number;
    readonly clampedSelected: number;
};

/** Centered half-window projection shared by every list tab. Pure. */
function computeWindow(selectedIndex: number, totalCount: number): WindowedView {
    const visibleCount = Math.min(MISSION_PANEL_MAX_VISIBLE, totalCount);
    const clampedSelected = Math.min(Math.max(selectedIndex, 0), Math.max(totalCount - 1, 0));
    const startIndex =
        totalCount <= visibleCount
            ? 0
            : Math.min(Math.max(clampedSelected - Math.floor(visibleCount / 2), 0), totalCount - visibleCount);
    return { startIndex, visibleCount, clampedSelected };
}

export type MissionRunRow = {
    readonly id: string;
    readonly label: string;
    readonly status?: string;
    readonly detail?: string;
};

export function renderRunsTab(selectedIndex: number, rows: readonly MissionRunRow[]): React.ReactNode {
    if (rows.length === 0) {
        return (
            <box marginTop={1}>
                <text attributes={TextAttributes.DIM}>No missions or runs recorded yet.</text>
            </box>
        );
    }
    const { startIndex, visibleCount, clampedSelected } = computeWindow(selectedIndex, rows.length);
    const visibleRows = rows.slice(startIndex, startIndex + visibleCount);
    return (
        <box flexDirection="column" marginTop={1}>
            <text attributes={TextAttributes.DIM}>
                {`${startIndex + 1}-${startIndex + visibleRows.length} of ${rows.length}`}
            </text>
            {visibleRows.map((row, index) => {
                const isSelected = startIndex + index === clampedSelected;
                const status = row.status ?? '';
                return (
                    <box key={row.id} flexDirection="row" {...(isSelected ? { bg: SELECTED_BG } : {})}>
                        <text>
                            {isSelected ? '> ' : '  '}
                            {row.label}
                        </text>
                        {status.length > 0 ? <text fg={statusColor(status)}>{` [${status}]`}</text> : null}
                        {row.detail !== undefined ? (
                            <text attributes={TextAttributes.DIM}>{` ${row.detail}`}</text>
                        ) : null}
                    </box>
                );
            })}
        </box>
    );
}

export function renderJobsTab(selectedIndex: number, rows: readonly JobPanelRow[]): React.ReactNode {
    if (rows.length === 0) {
        return (
            <box marginTop={1}>
                <text attributes={TextAttributes.DIM}>No active jobs.</text>
            </box>
        );
    }
    const { startIndex, visibleCount, clampedSelected } = computeWindow(selectedIndex, rows.length);
    const visibleRows = rows.slice(startIndex, startIndex + visibleCount);
    return (
        <box flexDirection="column" marginTop={1}>
            <text attributes={TextAttributes.DIM}>
                {`${startIndex + 1}-${startIndex + visibleRows.length} of ${rows.length}`}
            </text>
            {visibleRows.map((row, index) => {
                const isSelected = startIndex + index === clampedSelected;
                return (
                    <box key={row.id} flexDirection="column" {...(isSelected ? { bg: SELECTED_BG } : {})}>
                        <box flexDirection="row">
                            <text>{`${isSelected ? '> ' : '  '}${row.label}`}</text>
                            <text fg={jobStatusColor(row.status)}>{` [${row.status}]`}</text>
                            {row.detail !== undefined ? (
                                <text attributes={TextAttributes.DIM}>{` ${row.detail}`}</text>
                            ) : null}
                        </box>
                        {row.error !== undefined ? <text fg="#ff6b6b">{`    ${row.error}`}</text> : null}
                    </box>
                );
            })}
        </box>
    );
}

export function renderAgentsTab(selectedIndex: number, rows: readonly AgentPanelRow[]): React.ReactNode {
    if (rows.length === 0) {
        return (
            <box marginTop={1}>
                <text attributes={TextAttributes.DIM}>No tracked agents.</text>
            </box>
        );
    }
    const { startIndex, visibleCount, clampedSelected } = computeWindow(selectedIndex, rows.length);
    const visibleRows = rows.slice(startIndex, startIndex + visibleCount);
    return (
        <box flexDirection="column" marginTop={1}>
            <text attributes={TextAttributes.DIM}>
                {`${startIndex + 1}-${startIndex + visibleRows.length} of ${rows.length}`}
            </text>
            {visibleRows.map((row, index) => {
                const isSelected = startIndex + index === clampedSelected;
                return (
                    <box key={row.id} flexDirection="row" {...(isSelected ? { bg: SELECTED_BG } : {})}>
                        <text>{`${isSelected ? '> ' : '  '}${row.label}`}</text>
                        <text fg={agentStatusColor(row.status)}>{` [${row.status}]`}</text>
                        {row.detail !== undefined ? (
                            <text attributes={TextAttributes.DIM}>{` ${row.detail}`}</text>
                        ) : null}
                    </box>
                );
            })}
        </box>
    );
}

export function renderDrainTab(): React.ReactNode {
    const lines = DRAIN_TAB_MESSAGE.split('\n');
    const header = lines[0] ?? '';
    const body = lines.slice(1).join('\n');
    return (
        <box flexDirection="column" marginTop={1}>
            <text attributes={TextAttributes.BOLD}>{header}</text>
            <text attributes={TextAttributes.DIM}>{body}</text>
        </box>
    );
}

export function renderContinueTab(state: ContinuationState | null): React.ReactNode {
    if (state === null) {
        return (
            <box marginTop={1}>
                <text attributes={TextAttributes.DIM}>No continuation state found.</text>
            </box>
        );
    }
    const view = buildContinuationPanelView(state);
    const loopLabel = view.loopActive ? 'active' : 'inactive';
    const doneLabel = view.doneSignal ? 'received' : 'not received';
    return (
        <box flexDirection="column" marginTop={1}>
            <text>{`Iteration: ${view.iteration}`}</text>
            <text>{`Loop: ${loopLabel}`}</text>
            <text>{`Done signal: ${doneLabel}`}</text>
            <text>{`Last session: ${view.lastSessionId ?? '(none)'}`}</text>
            <text attributes={TextAttributes.DIM}>{`Reason: ${view.reason}`}</text>
        </box>
    );
}

function statusColor(status: string): string {
    switch (status) {
        case 'completed':
            return '#26d926';
        case 'failed':
        case 'cancelled':
            return '#ff6b6b';
        case 'running':
            return '#00ffff';
        case 'blocked':
        case 'pending':
            return '#ffaa00';
        default:
            return '#aaaaaa';
    }
}
