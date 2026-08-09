/** @jsxImportSource @opentui/solid */

import type { AgentRef, BackgroundJobHandle } from '@mission-control/core';
import { ContinuationRuntime, type ContinuationState, MAIN_AGENT_ID, readBoulder } from '@mission-control/core';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup } from 'solid-js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector';
import type { ChatAppActions } from '../state/chat-app-actions';
import type { ChatStore, MissionPanelTab } from '../state/chat-store';
import type { MissionControlServicesLike } from '../state/mission-services-types';
import { buildAgentPanelRows, buildJobPanelRows } from './mission-panel-rows';
import { renderAgentsTab, renderContinueTab, renderDrainTab, renderJobsTab, renderRunsTab } from './mission-panel-tabs';
import { OverlayFrame } from './OverlayFrame';

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
    const mcRoot = services.getMcRoot();
    const boulder = await readBoulder(mcRoot);
    if (boulder === null) return null;
    const workId = boulder.active_work_id;
    if (workId === null) return null;
    const runtime = new ContinuationRuntime({ boulderRoot: mcRoot, maxIterations: 0, workId });
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
}: MissionPanelOverlayProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (state) => state);
    const panel = createMemo(() => snapshot().missionPanel);
    const jobs = createMemo(() => {
        panel();
        return services !== undefined ? services.getJobManager().listJobs() : NO_JOBS;
    });
    const jobRows = createMemo(() => buildJobPanelRows(jobs()));
    const agents = createMemo(() => {
        panel();
        return services !== undefined ? services.getRuntimeRegistry().listVisibleTo(MAIN_AGENT_ID) : NO_AGENTS;
    });
    const agentRows = createMemo(() => buildAgentPanelRows(agents()));

    const [continuationState, setContinuationState] = createSignal<ContinuationState | null>(null);

    const reloadContinuation = async (): Promise<void> => {
        try {
            const state = await loadContinuationState(services);
            if (store.isEventQueueClosed() || store.getSnapshot().overlayMode !== 'mission-panel') return;
            setContinuationState(state);
        } catch {
            // Continuation load failures must not reject the overlay keyboard path.
        }
    };

    createEffect(() => {
        if (panel().activeTab !== 'continue') return;
        let cancelled = false;
        void (async () => {
            try {
                const state = await loadContinuationState(services);
                if (cancelled) return;
                if (store.isEventQueueClosed() || store.getSnapshot().overlayMode !== 'mission-panel') return;
                setContinuationState(state);
            } catch {
                // Continuation load failures must not surface as unhandled rejections.
            }
        })();
        onCleanup(() => {
            cancelled = true;
        });
    });

    const cycleTab = (delta: number): void => {
        const idx = MISSION_PANEL_TABS.indexOf(panel().activeTab);
        const next = MISSION_PANEL_TABS[(idx + delta + MISSION_PANEL_TABS.length) % MISSION_PANEL_TABS.length];
        if (next !== undefined) {
            store.setMissionPanelTab(next);
        }
    };

    const loadMissionPanelRows = actions?.loadMissionPanelRows;
    const reload = (): void => {
        if (workspaceRoot === undefined) return;
        const generation = store.beginMissionsReload();
        if (generation < 0) return;
        void (async () => {
            try {
                await reloadContinuation();
                if (!store.shouldApplyMissionsReload(generation)) return;
                const rows =
                    loadMissionPanelRows !== undefined
                        ? await loadMissionPanelRows(workspaceRoot)
                        : [];
                if (!store.shouldApplyMissionsReload(generation)) return;
                store.reloadMissions(rows);
            } catch {
                // Loader failures must not surface as unhandled rejections; generation gate drops stale applies.
            }
        })();
    };

    let settled = false;
    useKeyboard((key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            if (settled) return;
            settled = true;
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
        if (panel().activeTab !== 'runs' && panel().activeTab !== 'jobs' && panel().activeTab !== 'agents') return;
        const navCount =
            panel().activeTab === 'runs'
                ? panel().rows.length
                : panel().activeTab === 'jobs'
                  ? jobRows().length
                  : agentRows().length;
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
                <For each={MISSION_PANEL_TABS}>
                    {(tab) => {
                        const active = tab === panel().activeTab;
                        return (
                            <text {...(active ? { attributes: TextAttributes.BOLD } : {})}>
                                {`${active ? '[' : ' '} ${TAB_LABELS[tab]} ${active ? ']' : ' '}`}
                            </text>
                        );
                    }}
                </For>
            </box>
            {panel().activeTab === 'runs'
                ? renderRunsTab(() => panel().selectedIndex, panel().rows)
                : panel().activeTab === 'jobs'
                  ? renderJobsTab(() => panel().selectedIndex, jobRows())
                  : panel().activeTab === 'agents'
                    ? renderAgentsTab(() => panel().selectedIndex, agentRows())
                    : panel().activeTab === 'drain'
                      ? renderDrainTab()
                      : renderContinueTab(continuationState())}
        </OverlayFrame>
    );
}
