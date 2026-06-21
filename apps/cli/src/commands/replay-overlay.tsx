import { type AgentEvent, type AgentEventEnvelope } from '@mission-control/protocol';
import { Box, render, Text, useInput } from 'ink';
import { useCallback, useState } from 'react';
import { AbgOverlay } from '../components/AbgOverlay.js';
import { createAbgOverlayStore, projectAgentEvent } from './abg-overlay-state.js';

export type ReplayOverlayOptions = {
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
    readonly modelLabel?: string;
};

export async function runReplayOverlay(options: ReplayOverlayOptions): Promise<void> {
    return new Promise((resolve) => {
        const store = createAbgOverlayStore();
        let cursor = 0;
        let done = false;

        const stepTo = (target: number): void => {
            const clamped = Math.max(0, Math.min(target, options.envelopes.length));
            cursor = clamped;
            store.update((draft) => {
                const snapshot = store.getSnapshot();
                const next = { ...snapshot };
                if (target < cursor) {
                    // Reset to start and replay forward (simplest correct semantics).
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

        // Initialize cursor at the END so the user sees the final state immediately.
        stepTo(options.envelopes.length);

        const ReplayRoot = (): React.ReactElement => {
            const [activeTab, setActiveTab] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7>(0);
            const [scrollOffset, setScrollOffset] = useState(0);
            const [liveOutput, setLiveOutput] = useState(true);

            useInput((input, key) => {
                if (input === 'q' || key.escape) {
                    if (!done) {
                        done = true;
                        app.unmount();
                        resolve();
                    }
                    return;
                }
                if (key.leftArrow) {
                    stepTo(cursor - 1);
                    return;
                }
                if (key.rightArrow) {
                    stepTo(cursor + 1);
                    return;
                }
                if (key.upArrow) {
                    setScrollOffset((offset) => offset + 1);
                    return;
                }
                if (key.downArrow) {
                    setScrollOffset((offset) => Math.max(0, offset - 1));
                    return;
                }
                if (input >= '1' && input <= '8') {
                    setActiveTab((Number.parseInt(input, 10) - 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7);
                    setScrollOffset(0);
                    return;
                }
                if (input === 't') {
                    setLiveOutput((value) => !value);
                    return;
                }
                if (input === '0') {
                    stepTo(0);
                    return;
                }
                if (input === '$') {
                    stepTo(options.envelopes.length);
                    return;
                }
            });

            return (
                <Box flexDirection="column">
                    <Box>
                        <Text bold color="magenta">
                            [REPLAY]
                        </Text>
                        <Text dimColor> session={options.sessionId} </Text>
                        <Text dimColor>
                            event {cursor}/{options.envelopes.length}
                        </Text>
                    </Box>
                    <AbgOverlay
                        store={store}
                        activeTab={tabByIndex(activeTab)}
                        scrollOffset={scrollOffset}
                        modelLabel={options.modelLabel ?? 'replay'}
                    />
                    <Box marginTop={1}>
                        <Text dimColor>← → step | 0/$ jump | 1-8 tabs | ↑↓ scroll | t live | q/Esc quit</Text>
                    </Box>
                </Box>
            );
        };

        const app = render(<ReplayRoot />, { exitOnCtrlC: false });
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
