import type { AbgGraphSnapshot, AbgSignal, AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    createAbgOverlayStore,
    DEFAULT_REFRESH_MS,
    extractUsageFromModelCallCompleted,
    mergeGraphSnapshot,
    projectAbgSignal,
    projectAgentEvent,
    RECENT_EVENTS_CAP,
    readRefreshMsFromEnv,
} from './abg-overlay-state.js';

const SECRET = 'sk-1234567890abcdef';
const TS = '2026-01-01T00:00:00.000Z';

function startedSignal(nodeId: string, graphId?: string): AbgSignal {
    return {
        type: 'started',
        nodeId,
        ...(graphId !== undefined ? { graphId } : {}),
    };
}

function successSignal(nodeId: string): AbgSignal {
    return { type: 'success', nodeId };
}

function failureSignal(nodeId: string, error: unknown): AbgSignal {
    return { type: 'failure', nodeId, error };
}

function emitDeltaSignal(nodeId: string, delta: string): AbgSignal {
    return {
        type: 'emit',
        nodeId,
        event: {
            id: 'e1',
            type: 'llm.text.delta',
            source: 'test',
            timestamp: TS,
            payload: { delta },
        },
    };
}

/** An emit signal whose payload access throws, used to prove the non-throwing guarantee. */
function malformedEmitSignal(): AbgSignal {
    return {
        type: 'emit',
        nodeId: 'boom',
        event: {
            id: 'e1',
            type: 'llm.text.delta',
            source: 'test',
            timestamp: TS,
            get payload(): unknown {
                throw new Error('malformed payload access');
            },
        },
    };
}

function graphEvent(
    type: 'graph.started' | 'graph.completed' | 'graph.failed' | 'graph.cancelled',
    graphId?: string,
): AgentEvent {
    const base: AgentEvent = { type, timestamp: TS };
    if (graphId === undefined) return base;
    return { ...base, abg: { graphId } };
}

function runEvent(
    type: 'run.started' | 'run.completed' | 'run.interrupted' | 'run.failed' | 'run.blocked' | 'run.idle',
): AgentEvent {
    return { type, timestamp: TS };
}

function nodeFailedEvent(nodeId: string, message: string): AgentEvent {
    return { type: 'node.failed', timestamp: TS, message, abg: { graphId: 'g1', nodeId, signalType: 'failure' } };
}

type FakeUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

function modelCallCompleted(usage: FakeUsage | undefined): AgentEvent {
    const base: AgentEvent = { type: 'model.call.completed', timestamp: TS };
    if (usage === undefined) return base;
    return {
        ...base,
        providerStreamChunk: {
            kind: 'response_completed',
            requestId: 'r1',
            sequence: 1,
            message: { messageId: 'm1', role: 'assistant', content: 'ok' },
            finishReason: 'stop',
            usage,
        },
    };
}

function snapshot(status: AbgGraphSnapshot['status'], nodeId?: string): AbgGraphSnapshot {
    return {
        graphId: 'g1',
        status,
        activeNodeIds: nodeId === undefined ? [] : [nodeId],
        nodes: nodeId === undefined ? [] : [{ nodeId, status: 'running' }],
        blackboard: [],
        approvals: [],
        toolOutcomes: [],
    };
}

function progressSignal(nodeId: string, message?: string): AbgSignal {
    return { type: 'progress', nodeId, ...(message !== undefined ? { message } : {}) };
}

function cancelledSignal(nodeId: string, reason?: string): AbgSignal {
    return { type: 'cancelled', nodeId, ...(reason !== undefined ? { reason } : {}) };
}

function selectSignal(nodeId: string, target: string): AbgSignal {
    return { type: 'select', nodeId, target };
}

function transitionSignal(nodeId: string, from: string, to: string): AbgSignal {
    return { type: 'transition', nodeId, from, to };
}

function spawnSignal(nodeId: string, actor: string): AbgSignal {
    return { type: 'spawn', nodeId, actor };
}

function cancelSignal(nodeId: string, target: string, reason?: string): AbgSignal {
    return { type: 'cancel', nodeId, target, ...(reason !== undefined ? { reason } : {}) };
}

function escalateSignal(nodeId: string, reason?: string): AbgSignal {
    return { type: 'escalate', nodeId, ...(reason !== undefined ? { reason } : {}) };
}

function fallbackSignal(nodeId: string, reason?: string): AbgSignal {
    return { type: 'fallback', nodeId, ...(reason !== undefined ? { reason } : {}) };
}

function emitTypedSignal(nodeId: string, eventType: string, payload?: unknown): AbgSignal {
    return {
        type: 'emit',
        nodeId,
        event: {
            id: 'e1',
            type: eventType,
            source: 'test',
            timestamp: TS,
            ...(payload !== undefined ? { payload } : {}),
        },
    };
}

function nativeStatusEvent(status: 'unknown' | 'mock' | 'native' | 'unavailable'): AgentEvent {
    return { type: 'native.status', timestamp: TS, nativeSidecarStatus: status };
}

function exactMatchEvent(type: 'workflow.transitioned' | 'decision.selected' | 'policy.blocked'): AgentEvent {
    return { type, timestamp: TS };
}

describe('abg overlay state', () => {
    describe('createAbgOverlayStore', () => {
        it('returns a referentially stable snapshot until update or reset', () => {
            const store = createAbgOverlayStore();
            const first = store.getSnapshot();
            const second = store.getSnapshot();
            expect(second).toBe(first);

            store.update((draft) => {
                draft.inputTokens = 1;
            });
            const third = store.getSnapshot();
            expect(third).not.toBe(first);
            expect(third.inputTokens).toBe(1);
        });

        it('notifies subscribers on update and unsubscribe stops delivery', () => {
            const store = createAbgOverlayStore();
            let calls = 0;
            const unsubscribe = store.subscribe(() => {
                calls += 1;
            });
            store.update((draft) => {
                draft.inputTokens = 1;
            });
            expect(calls).toBe(1);
            unsubscribe();
            store.update((draft) => {
                draft.inputTokens = 2;
            });
            expect(calls).toBe(1);
        });

        it('tracks active flag independently of state', () => {
            const store = createAbgOverlayStore();
            expect(store.isActive()).toBe(false);
            store.setActive(true);
            expect(store.isActive()).toBe(true);
            store.setActive(false);
            expect(store.isActive()).toBe(false);
        });

        it('reset clears every field to its default (Metis 5.3 no-leak)', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                draft.activeGraphId = 'g1';
                draft.graphStatus = 'active';
                draft.nodes.set('n1', 'running');
                draft.activeNodeIds = ['n1'];
                draft.toolOutcomes = [{ toolId: 't1', status: 'completed' }];
                draft.recentEvents.push({ timestamp: TS, type: 'node.started', message: 'x' });
                draft.pendingApprovals = [];
                draft.costCents = 5;
                draft.inputTokens = 10;
                draft.outputTokens = 20;
                draft.modelCalls = 2;
                draft.lastLiveDelta = 'delta';
                draft.lastError = 'boom';
                draft.runState = 'running';
                draft.nativeSidecarStatus = 'mock';
                draft.lastSettledAt = TS;
            });
            store.setActive(true);

            store.reset();

            const state = store.getSnapshot();
            expect(state.activeGraphId).toBeUndefined();
            expect(state.graphStatus).toBeUndefined();
            expect(state.nodes.size).toBe(0);
            expect(state.activeNodeIds).toHaveLength(0);
            expect(state.toolOutcomes).toHaveLength(0);
            expect(state.recentEvents).toHaveLength(0);
            expect(state.pendingApprovals).toHaveLength(0);
            expect(state.costCents).toBeUndefined();
            expect(state.inputTokens).toBe(0);
            expect(state.outputTokens).toBe(0);
            expect(state.modelCalls).toBe(0);
            expect(state.lastLiveDelta).toBe('');
            expect(state.lastError).toBeUndefined();
            expect(state.runState).toBe('idle');
            expect(state.nativeSidecarStatus).toBe('');
            expect(state.lastSettledAt).toBeUndefined();
            // active flag is controller-managed; reset() does not touch it.
            expect(store.isActive()).toBe(true);
        });
    });

    describe('projectAbgSignal', () => {
        it('walks the happy graph lifecycle through signals and events', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, mergeGraphSnapshot(draft, snapshot('created')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, graphEvent('graph.started')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, startedSignal('n1')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, emitDeltaSignal('n1', 'hello world')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, successSignal('n1')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, graphEvent('graph.completed')));
            });

            const state = store.getSnapshot();
            expect(state.graphStatus).toBe('completed');
            expect(state.nodes.get('n1')).toBe('succeeded');
            expect(state.recentEvents).toHaveLength(5);
            expect(state.lastLiveDelta).toContain('hello world');
        });

        it('maps started/progress to running and failure to failed with lastError', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, startedSignal('n1')));
            });
            expect(store.getSnapshot().nodes.get('n1')).toBe('running');
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, failureSignal('n1', { message: 'kaput' })));
            });
            const state = store.getSnapshot();
            expect(state.nodes.get('n1')).toBe('failed');
            expect(state.lastError).toBe('kaput');
        });

        it('returns an empty patch and does not throw on a malformed signal (Metis 4.1)', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, startedSignal('n1')));
            });
            const before = store.getSnapshot();

            const patch = projectAbgSignal(store.getSnapshot(), malformedEmitSignal());
            expect(patch).toEqual({});

            // Applying the empty patch is a no-op (state reference unchanged until update()).
            expect(store.getSnapshot()).toBe(before);
            expect(store.getSnapshot().nodes.get('n1')).toBe('running');
        });

        it('caps recentEvents at RECENT_EVENTS_CAP', () => {
            const store = createAbgOverlayStore();
            for (let index = 0; index < RECENT_EVENTS_CAP + 50; index += 1) {
                const signal = startedSignal(`n${index}`);
                store.update((draft) => {
                    Object.assign(draft, projectAbgSignal(draft, signal));
                });
            }
            const state = store.getSnapshot();
            expect(state.recentEvents).toHaveLength(RECENT_EVENTS_CAP);
            // Newest entries are retained (rolling window drops the oldest).
            const last = state.recentEvents[RECENT_EVENTS_CAP - 1];
            expect(last?.type).toBe('node.started');
        });

        it('redacts credential patterns in lastLiveDelta and recent message', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, emitDeltaSignal('n1', `leaking ${SECRET} now`)));
            });
            const state = store.getSnapshot();
            expect(state.lastLiveDelta).not.toContain(SECRET);
            expect(state.lastLiveDelta).toContain('[REDACTED_CREDENTIAL]');
            const entry = state.recentEvents[0];
            expect(entry?.message).not.toContain(SECRET);
            expect(entry?.emitPayloadText).not.toContain(SECRET);
        });

        it('maps progress, select, transition, and spawn signals to running status', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, progressSignal('n1', 'halfway')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, selectSignal('n1', 'n2')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, transitionSignal('n1', 'a', 'b')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, spawnSignal('n1', 'child')));
            });

            const state = store.getSnapshot();
            expect(state.nodes.get('n1')).toBe('running');
            expect(state.recentEvents).toHaveLength(4);
            const progressEntry = state.recentEvents.find((e) => e.signal === 'progress');
            expect(progressEntry?.message).toBe('halfway');
            const selectEntry = state.recentEvents.find((e) => e.signal === 'select');
            expect(selectEntry?.message).toContain('n2');
        });

        it('maps cancelled signal to cancelled status with a redacted reason', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, cancelledSignal('n1', 'abort reason')));
            });

            const state = store.getSnapshot();
            expect(state.nodes.get('n1')).toBe('cancelled');
            expect(state.recentEvents[0]?.signal).toBe('cancelled');
            expect(state.recentEvents[0]?.message).toBe('abort reason');
        });

        it('records cancel, escalate, and fallback as timeline-only control signals', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, cancelSignal('n1', 'n2', 'timeout')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, escalateSignal('n1', 'need human')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, fallbackSignal('n1', 'retry exhausted')));
            });

            const state = store.getSnapshot();
            expect(state.nodes.size).toBe(0);
            expect(state.recentEvents).toHaveLength(3);
            expect(state.recentEvents[0]?.message).toBe('timeout');
            expect(state.recentEvents[1]?.message).toBe('need human');
            expect(state.recentEvents[2]?.message).toBe('retry exhausted');
        });

        it('handles string, undefined, and unserializable emit payloads', () => {
            const store = createAbgOverlayStore();

            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, emitTypedSignal('n1', 'llm.text.delta', 'raw text')));
            });
            expect(store.getSnapshot().lastLiveDelta).toBe('raw text');

            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, emitTypedSignal('n1', 'llm.text.delta')));
            });
            expect(store.getSnapshot().lastLiveDelta).toBe('');

            const circular: Record<string, unknown> = {};
            // biome-ignore lint/complexity/useLiteralKeys: Record<string, unknown> requires bracket access per noPropertyAccessFromIndexSignature
            circular['self'] = circular;
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, emitTypedSignal('n1', 'tool.started', circular)));
            });
            const entry = store.getSnapshot().recentEvents.at(-1);
            expect(entry?.emitPayloadText).toBe('[unserializable]');
        });

        it('does not set lastLiveDelta for non-delta emit events', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, emitTypedSignal('n1', 'tool.started', { toolName: 'x' })));
            });

            const state = store.getSnapshot();
            expect(state.lastLiveDelta).toBe('');
            expect(state.recentEvents).toHaveLength(1);
            expect(state.nodes.get('n1')).toBe('running');
        });

        it('handles string and non-object errors in failure signals', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, failureSignal('n1', 'plain string error')));
            });
            expect(store.getSnapshot().lastError).toBe('plain string error');

            store.update((draft) => {
                Object.assign(draft, projectAbgSignal(draft, failureSignal('n2', 42)));
            });
            expect(store.getSnapshot().lastError).toBe('42');
        });
    });

    describe('projectAgentEvent', () => {
        it('ignores events outside the overlay-relevant set', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, { type: 'log', timestamp: TS }));
            });
            expect(store.getSnapshot().recentEvents).toHaveLength(0);
        });

        it('flips runState on run.* events and records lastSettledAt for terminal states', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, runEvent('run.started')));
            });
            expect(store.getSnapshot().runState).toBe('running');
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, runEvent('run.interrupted')));
            });
            const state = store.getSnapshot();
            expect(state.runState).toBe('interrupted');
            expect(state.lastSettledAt).toBe(TS);
        });

        it('redacts the message column for new display surfaces', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, nodeFailedEvent('n1', `err ${SECRET}`)));
            });
            const last = store.getSnapshot().recentEvents.at(-1);
            expect(last?.message).not.toContain(SECRET);
            expect(last?.message).toContain('[REDACTED_CREDENTIAL]');
        });

        it('projects exact-match overlay events without abg.graphId (workflow, decision, policy)', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, exactMatchEvent('workflow.transitioned')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, exactMatchEvent('decision.selected')));
            });
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, exactMatchEvent('policy.blocked')));
            });
            expect(store.getSnapshot().recentEvents).toHaveLength(3);
        });

        it('maps run.completed, run.failed, run.blocked, and run.idle to run states', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, runEvent('run.completed')));
            });
            expect(store.getSnapshot().runState).toBe('completed');
            expect(store.getSnapshot().lastSettledAt).toBe(TS);

            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, runEvent('run.failed')));
            });
            expect(store.getSnapshot().runState).toBe('failed');

            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, runEvent('run.blocked')));
            });
            expect(store.getSnapshot().runState).toBe('blocked_on_approval');

            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, runEvent('run.idle')));
            });
            expect(store.getSnapshot().runState).toBe('idle');
        });

        it('maps graph.failed and graph.cancelled to graph statuses', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, graphEvent('graph.failed', 'g1')));
            });
            expect(store.getSnapshot().graphStatus).toBe('failed');

            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, graphEvent('graph.cancelled', 'g1')));
            });
            expect(store.getSnapshot().graphStatus).toBe('cancelled');
        });

        it('captures nativeSidecarStatus on native.status events', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(draft, projectAgentEvent(draft, nativeStatusEvent('native')));
            });
            expect(store.getSnapshot().nativeSidecarStatus).toBe('native');
        });
    });

    describe('extractUsageFromModelCallCompleted (Metis 1.4)', () => {
        it('returns undefined when no usage chunk is present', () => {
            expect(extractUsageFromModelCallCompleted(modelCallCompleted(undefined))).toBeUndefined();
        });

        it('returns token counts but never a costCents value', () => {
            const usage = extractUsageFromModelCallCompleted(
                modelCallCompleted({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
            );
            expect(usage?.inputTokens).toBe(100);
            expect(usage?.outputTokens).toBe(50);
            expect(usage?.costCents).toBeUndefined();
        });

        it('accumulates tokens via projectAgentEvent and leaves costCents undefined', () => {
            const store = createAbgOverlayStore();
            store.update((draft) => {
                Object.assign(
                    draft,
                    projectAgentEvent(
                        draft,
                        modelCallCompleted({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
                    ),
                );
            });
            store.update((draft) => {
                Object.assign(
                    draft,
                    projectAgentEvent(draft, modelCallCompleted({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })),
                );
            });
            const state = store.getSnapshot();
            expect(state.inputTokens).toBe(107);
            expect(state.outputTokens).toBe(53);
            expect(state.modelCalls).toBe(2);
            expect(state.costCents).toBeUndefined();
        });

        it('returns undefined for non model.call.completed events', () => {
            expect(extractUsageFromModelCallCompleted(runEvent('run.completed'))).toBeUndefined();
        });

        it('returns undefined when the response_completed chunk lacks a usage block', () => {
            const event: AgentEvent = {
                type: 'model.call.completed',
                timestamp: TS,
                providerStreamChunk: {
                    kind: 'response_completed',
                    requestId: 'r1',
                    sequence: 1,
                    message: { messageId: 'm1', role: 'assistant', content: 'ok' },
                    finishReason: 'stop',
                },
            };
            expect(extractUsageFromModelCallCompleted(event)).toBeUndefined();
        });
    });

    describe('mergeGraphSnapshot', () => {
        it('overlays durable graph fields and node statuses from the snapshot', () => {
            const store = createAbgOverlayStore();
            const snap: AbgGraphSnapshot = {
                graphId: 'g1',
                status: 'active',
                activeNodeIds: ['n1'],
                nodes: [{ nodeId: 'n1', status: 'running' }],
                blackboard: [],
                approvals: [],
                toolOutcomes: [{ toolId: 't1', status: 'completed' }],
            };
            store.update((draft) => {
                Object.assign(draft, mergeGraphSnapshot(draft, snap));
            });
            const state = store.getSnapshot();
            expect(state.activeGraphId).toBe('g1');
            expect(state.graphStatus).toBe('active');
            expect(state.activeNodeIds).toEqual(['n1']);
            expect(state.nodes.get('n1')).toBe('running');
            expect(state.toolOutcomes).toHaveLength(1);
        });

        it('redacts toolOutcomes lastMessage (Oracle security finding)', () => {
            const store = createAbgOverlayStore();
            const snap: AbgGraphSnapshot = {
                graphId: 'g1',
                status: 'active',
                activeNodeIds: [],
                nodes: [],
                blackboard: [],
                approvals: [],
                toolOutcomes: [{ toolId: 't1', status: 'completed', lastMessage: `output ${SECRET}` }],
            };
            store.update((draft) => {
                Object.assign(draft, mergeGraphSnapshot(draft, snap));
            });
            const outcome = store.getSnapshot().toolOutcomes[0];
            expect(outcome?.lastMessage).not.toContain(SECRET);
            expect(outcome?.lastMessage).toContain('[REDACTED_CREDENTIAL]');
        });

        it('folds lastSignal from the durable snapshot into recentEvents', () => {
            const store = createAbgOverlayStore();
            const withEmit: AbgGraphSnapshot = {
                graphId: 'g1',
                status: 'active',
                activeNodeIds: [],
                nodes: [],
                blackboard: [],
                approvals: [],
                toolOutcomes: [],
                lastSignal: emitDeltaSignal('n1', 'hi'),
            };
            store.update((draft) => {
                Object.assign(draft, mergeGraphSnapshot(draft, withEmit));
            });
            const withStarted: AbgGraphSnapshot = {
                graphId: 'g1',
                status: 'active',
                activeNodeIds: [],
                nodes: [],
                blackboard: [],
                approvals: [],
                toolOutcomes: [],
                lastSignal: startedSignal('n1'),
            };
            store.update((draft) => {
                Object.assign(draft, mergeGraphSnapshot(draft, withStarted));
            });

            const state = store.getSnapshot();
            expect(state.recentEvents).toHaveLength(2);
            expect(state.recentEvents[0]?.type).toBe('llm.text.delta');
            expect(state.recentEvents[1]?.type).toBe('signal.started');
        });
    });

    describe('readRefreshMsFromEnv', () => {
        it('defaults to DEFAULT_REFRESH_MS when the var is absent', () => {
            // biome-ignore lint/complexity/useLiteralKeys: process.env (NodeJS.ProcessEnv) requires bracket access per noPropertyAccessFromIndexSignature
            delete process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'];
            expect(readRefreshMsFromEnv()).toBe(DEFAULT_REFRESH_MS);
        });

        it('falls back to the default for non-numeric input', () => {
            // biome-ignore lint/complexity/useLiteralKeys: process.env (NodeJS.ProcessEnv) requires bracket access per noPropertyAccessFromIndexSignature
            process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'] = 'fast';
            expect(readRefreshMsFromEnv()).toBe(DEFAULT_REFRESH_MS);
            // biome-ignore lint/complexity/useLiteralKeys: process.env (NodeJS.ProcessEnv) requires bracket access per noPropertyAccessFromIndexSignature
            delete process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'];
        });

        it('honors a valid value and clamps below the 16ms floor', () => {
            // biome-ignore lint/complexity/useLiteralKeys: process.env (NodeJS.ProcessEnv) requires bracket access per noPropertyAccessFromIndexSignature
            process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'] = '50';
            expect(readRefreshMsFromEnv()).toBe(50);
            // biome-ignore lint/complexity/useLiteralKeys: process.env (NodeJS.ProcessEnv) requires bracket access per noPropertyAccessFromIndexSignature
            process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'] = '5';
            expect(readRefreshMsFromEnv()).toBe(16);
            // biome-ignore lint/complexity/useLiteralKeys: process.env (NodeJS.ProcessEnv) requires bracket access per noPropertyAccessFromIndexSignature
            delete process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'];
        });
    });
});
