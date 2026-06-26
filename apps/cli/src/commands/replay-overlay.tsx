/** @jsxImportSource @opentui/react */
import { type AgentEvent, type AgentEventEnvelope } from '@mission-control/protocol';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { AbgOverlay } from '../components/AbgOverlay.js';
import { type OpenTuiMountResult, mountOpenTui } from '../platform/opentui-renderer.js';
import { createAbgOverlayStore, projectAgentEvent } from './abg-overlay-state.js';

export type ReplayOverlayOptions = {
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
    readonly modelLabel?: string;
};

const dimAttrs = { dim: true };
const boldAttrs = { bold: true };
const magentaFg = '#ff00ff';

export async function runReplayOverlay(options: ReplayOverlayOptions): Promise<void> {
    return new Promise<void>((resolve) => {
        const store = createAbgOverlayStore();
        let cursor = 0;
        let done = false;
        let mountHandle: OpenTuiMountResult | undefined;

        const stepTo = (target: number): void => {
            const clamped = Math.max(0, Math.min(target, options.envelopes.length));
            cursor = clamped;
            store.update((draft) => {
                const snapshot = store.getSnapshot();
                const next = { ...snapshot };
                if (target < cursor) {
                    Object.assign(next, resetStateForReplay());
                }
                for (let i = 0; i < clamped; i += 1) {
                    const envelope = options.envelopes[i];
                    if (envelope === undefined) continue;
                    const patch = projectAgentEvent(next, envelope.event);
                    Object.assign(next, patch);
                }
                Object.assign(draft, next);
            });
        };

        stepTo(options.envelopes.length);

        const ReplayRoot = (): React.ReactNode => {
            const [activeTab, setActiveTab] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7>(0);
            const [scrollOffset, setScrollOffset] = useState(0);
            const [liveOutput, setLiveOutput] = useState(true);

            useKeyboard((key) => {
                if (key.name === 'q' || key.name === 'escape') {
                    if (!done) {
                        done = true;
                        mountHandle?.unmount();
                        resolve();
                    }
                    return;
                }
                if (key.name === 'left') {
                    stepTo(cursor - 1);
                    return;
                }
                if (key.name === 'right') {
                    stepTo(cursor + 1);
                    return;
                }
                if (key.name === 'up') {
                    setScrollOffset((offset) => offset + 1);
                    return;
                }
                if (key.name === 'down') {
                    setScrollOffset((offset) => Math.max(0, offset - 1));
                    return;
                }
                if (key.name >= '1' && key.name <= '8') {
                    setActiveTab((Number.parseInt(key.name, 10) - 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7);
                    setScrollOffset(0);
                    return;
                }
                if (key.name === 't') {
                    setLiveOutput((value) => !value);
                    return;
                }
                if (key.name === '0') {
                    stepTo(0);
                    return;
                }
                if (key.name === '$') {
                    stepTo(options.envelopes.length);
                    return;
                }
            });

            return (
                <box flexDirection="column">
                    <box>
                        <text {...(magentaFg !== undefined ? { fg: magentaFg } : {})} {...boldAttrs}>
                            [REPLAY]
                        </text>
                        <text {...dimAttrs}> session={options.sessionId} </text>
                        <text {...dimAttrs}>
                            event {cursor}/{options.envelopes.length}
                        </text>
                    </box>
                    <AbgOverlay
                        store={store}
                        activeTab={tabByIndex(activeTab)}
                        scrollOffset={scrollOffset}
                        modelLabel={options.modelLabel ?? 'replay'}
                    />
                    <box marginTop={1}>
                        <text {...dimAttrs}>← → step | 0/$ jump | 1-8 tabs | ↑↓ scroll | t live | q/Esc quit</text>
                    </box>
                </box>
            );
        };

        void mountOpenTui(<ReplayRoot />).then((handle) => {
            mountHandle = handle;
        });
    });
}

type AbgOverlayTab = 'overview' | 'graph' | 'nodes' | 'tools' | 'timeline' | 'approvals' | 'cost-policy' | 'blackboard';

function tabByIndex(index: number): AbgOverlayTab {
    const tabs: readonly AbgOverlayTab[] = [
        'overview',
        'graph',
        'nodes',
        'tools',
        'timeline',
        'approvals',
        'cost-policy',
        'blackboard',
    ];
    return tabs[index] ?? 'overview';
}

function resetStateForReplay() {
    return {
        activeGraphId: undefined,
        graphStatus: undefined,
        nodes: new Map(),
        activeNodeIds: [],
        toolOutcomes: [],
        recentEvents: [],
        pendingApprovals: [],
        blackboardEntries: new Map(),
        costCents: undefined,
        inputTokens: 0,
        outputTokens: 0,
        modelCalls: 0,
        lastLiveDelta: '',
        lastError: undefined,
        runState: 'idle' as const,
        nativeSidecarStatus: '',
        lastSettledAt: undefined,
    };
}

export type ReplayEvent = AgentEvent;
