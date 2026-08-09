/** @jsxImportSource @opentui/solid */
import { type AgentEvent, type AgentEventEnvelope } from '@mission-control/protocol';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { AbgOverlay } from './components/AbgOverlay';
import { mountOpenTui, type OpenTuiMountResult } from './platform/opentui-renderer';
import { createAbgOverlayStore, projectAgentEvent } from './state/index';
import { planReplayStep } from './state/replay-step';

export type ReplayOverlayOptions = {
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
    readonly modelLabel?: string;
};

const dimAttrs = { dim: true };
const boldAttrs = { bold: true };
const magentaFg = '#ff00ff';

export async function runReplayOverlay(options: ReplayOverlayOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const store = createAbgOverlayStore();
        let cursor = 0;
        let done = false;
        let mountHandle: OpenTuiMountResult | undefined;

        const stepTo = (target: number): void => {
            const plan = planReplayStep({
                cursor,
                target,
                envelopeCount: options.envelopes.length,
            });
            cursor = plan.cursor;
            store.update((draft) => {
                const snapshot = store.getSnapshot();
                const next = plan.reset ? { ...snapshot, ...resetStateForReplay() } : { ...snapshot };
                for (let i = plan.startIndex; i < plan.cursor; i += 1) {
                    const envelope = options.envelopes[i];
                    if (envelope === undefined) continue;
                    const patch = projectAgentEvent(next, envelope.event);
                    Object.assign(next, patch);
                }
                Object.assign(draft, next);
            });
        };

        stepTo(options.envelopes.length);

        const ReplayRoot = () => {
            const [activeTab, setActiveTab] = createSignal<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7>(0);
            const [scrollOffset, setScrollOffset] = createSignal(0);
            const [liveOutput, setLiveOutput] = createSignal(true);
            const [cursorValue, setCursorValue] = createSignal(cursor);
            const dimensions = useTerminalDimensions();

            const stepAndPublish = (target: number): void => {
                stepTo(target);
                setCursorValue(cursor);
            };

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
                    stepAndPublish(cursor - 1);
                    return;
                }
                if (key.name === 'right') {
                    stepAndPublish(cursor + 1);
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
                    stepAndPublish(0);
                    return;
                }
                if (key.name === '$') {
                    stepAndPublish(options.envelopes.length);
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
                            event {cursorValue()}/{options.envelopes.length}
                        </text>
                    </box>
                    <AbgOverlay
                        store={store}
                        activeTab={tabByIndex(activeTab())}
                        scrollOffset={scrollOffset()}
                        modelLabel={options.modelLabel ?? 'replay'}
                        viewport={{ columns: dimensions().width, rows: dimensions().height }}
                    />
                    <box marginTop={1}>
                        <text {...dimAttrs}>
                            ← → step | 0/$ jump | 1-8 tabs | ↑↓ scroll | t live {liveOutput() ? 'on' : 'off'} | q/Esc
                            quit
                        </text>
                    </box>
                </box>
            );
        };

        void mountOpenTui(() => <ReplayRoot />).then(
            (handle) => {
                mountHandle = handle;
            },
            (error: unknown) => {
                reject(error);
            },
        );
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
