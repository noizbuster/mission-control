/** @jsxImportSource @opentui/react */

import type { AgentRef, BackgroundJobHandle } from '@mission-control/core';
import { ContinuationRuntime, type ContinuationState, MAIN_AGENT_ID, readBoulder } from '@mission-control/core';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ChatAppActions } from '../state/chat-app-actions.js';
import type { ChatStore, MissionPanelTab } from '../state/chat-store.js';
import type { MissionControlServicesLike } from '../state/mission-services-types.js';
import { buildAgentPanelRows, buildJobPanelRows } from './mission-panel-rows.js';
import {
    renderAgentsTab,
    renderContinueTab,
    renderDrainTab,
    renderJobsTab,
    renderRunsTab,
} from './mission-panel-tabs.js';
import { OverlayFrame } from './OverlayFrame.js';

const MISSION_PANEL_TABS: readonly MissionPanelTab[] = ['runs', 'jobs', 'agents', 'drain', 'continue'];

const TAB_LABELS: Record<MissionPanelTab, string> = {
    runs: 'Runs',
    jobs: 'Jobs',
    agents: 'Agents',
    drain: 'Drain',
    continue: 'Continue',
};

const NO_JOBS: readonly BackgroundJobHandle[] = [];
const NO_AGENTS: readonly AgentRef[] = [];

async function loadContinuationState(
    services: MissionControlServicesLike | undefined,
): Promise<ContinuationState | null> {
    if (services === undefined) return null;
    const omoRoot = services.getOmoRoot();
    const boulder = await readBoulder(omoRoot);
    if (boulder === null) return null;
    const workId = boulder.active_work_id;
    if (workId === null) return null;
    const runtime = new ContinuationRuntime({ boulderRoot: omoRoot, maxIterations: 0, workId });
    return runtime.loadState();
}

export type MissionPanelOverlayProps = {
    readonly store: ChatStore;
    readonly workspaceRoot: string | undefined;
    readonly services?: MissionControlServicesLike;
    readonly actions?: ChatAppActions;
};

export function MissionPanelOverlay({
    store,
    workspaceRoot,
    services,
    actions,
}: MissionPanelOverlayProps): React.ReactNode {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);
    const panel = snapshot.missionPanel;

    const jobs = services !== undefined ? services.getJobManager().listJobs() : NO_JOBS;
    const jobRows = buildJobPanelRows(jobs);
    const agents = services !== undefined ? services.getRuntimeRegistry().listVisibleTo(MAIN_AGENT_ID) : NO_AGENTS;
    const agentRows = buildAgentPanelRows(agents);

    const [continuationState, setContinuationState] = useState<ContinuationState | null>(null);

    const reloadContinuation = useCallback(async (): Promise<void> => {
        setContinuationState(await loadContinuationState(services));
    }, [services]);

    useEffect(() => {
        if (panel.activeTab !== 'continue') return;
        let cancelled = false;
        void (async () => {
            const state = await loadContinuationState(services);
            if (!cancelled) setContinuationState(state);
        })();
        return () => {
            cancelled = true;
        };
    }, [panel.activeTab, services]);

    const cycleTab = useCallback(
        (delta: number): void => {
            const idx = MISSION_PANEL_TABS.indexOf(panel.activeTab);
            const next = MISSION_PANEL_TABS[(idx + delta + MISSION_PANEL_TABS.length) % MISSION_PANEL_TABS.length];
            if (next !== undefined) {
                store.setMissionPanelTab(next);
            }
        },
        [panel.activeTab, store],
    );

    const loadMissionPanelRows = actions?.loadMissionPanelRows;
    const reload = useCallback((): void => {
        if (workspaceRoot === undefined) return;
        void reloadContinuation();
        void (async () => {
            const rows =
                workspaceRoot !== undefined && loadMissionPanelRows !== undefined
                    ? await loadMissionPanelRows(workspaceRoot)
                    : [];
            store.reloadMissions(rows);
        })();
    }, [workspaceRoot, store, reloadContinuation, loadMissionPanelRows]);

    useKeyboard((key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            store.hideMissionPanel();
            return;
        }
        if (key.name === 'tab') {
            key.preventDefault();
            cycleTab(key.shift ? -1 : 1);
            return;
        }
        if (key.name === ']') {
            key.preventDefault();
            cycleTab(1);
            return;
        }
        if (key.name === '[') {
            key.preventDefault();
            cycleTab(-1);
            return;
        }
        if (key.ctrl && key.name === 'r') {
            reload();
            return;
        }
        // Arrow/j/k navigation is shared across runs/jobs/agents. Each tab
        // clamps against its own row count; the store cursor is reused.
        if (panel.activeTab !== 'runs' && panel.activeTab !== 'jobs' && panel.activeTab !== 'agents') return;
        const navCount =
            panel.activeTab === 'runs'
                ? panel.rows.length
                : panel.activeTab === 'jobs'
                  ? jobRows.length
                  : agentRows.length;
        if (navCount === 0) return;
        if (key.name === 'up' || key.name === 'k') {
            key.preventDefault();
            store.navigateMissionPanel(-1, navCount);
            return;
        }
        if (key.name === 'down' || key.name === 'j') {
            key.preventDefault();
            store.navigateMissionPanel(1, navCount);
            return;
        }
    });

    return (
        <OverlayFrame
            variant="modal"
            title="Mission Control"
            footer="Tab/[ ] cycle · Up/Dn navigate · Ctrl+R reload · Esc close"
        >
            <box flexDirection="row">
                {MISSION_PANEL_TABS.map((tab) => {
                    const active = tab === panel.activeTab;
                    return (
                        <text key={tab} {...(active ? { attributes: TextAttributes.BOLD } : {})}>
                            {`${active ? '[' : ' '} ${TAB_LABELS[tab]} ${active ? ']' : ' '}`}
                        </text>
                    );
                })}
            </box>
            {panel.activeTab === 'runs'
                ? renderRunsTab(panel.selectedIndex, panel.rows)
                : panel.activeTab === 'jobs'
                  ? renderJobsTab(panel.selectedIndex, jobRows)
                  : panel.activeTab === 'agents'
                    ? renderAgentsTab(panel.selectedIndex, agentRows)
                    : panel.activeTab === 'drain'
                      ? renderDrainTab()
                      : renderContinueTab(continuationState)}
        </OverlayFrame>
    );
}
