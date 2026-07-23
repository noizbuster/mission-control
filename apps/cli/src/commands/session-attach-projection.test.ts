import type { AgentEvent, GraphCheckpoint } from '@mission-control/protocol';
import { createAbgOverlayController, createAbgOverlayStore } from '@mission-control/tui/state';
import { describe, expect, it, vi } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import {
    applySessionAttachProjection,
    clearStickyAttachBanner,
    projectSessionAttachFromEvents,
    RESUMABLE_ATTACH_BANNER,
} from './session-attach-projection';

const TIMESTAMP = '2026-07-20T12:00:00.000Z';
const SESSION_ID = 'session_attach';

function baseEvent(type: AgentEvent['type'], overrides: Partial<AgentEvent> = {}): AgentEvent {
    return {
        type,
        timestamp: TIMESTAMP,
        sessionId: SESSION_ID,
        message: type,
        ...overrides,
    };
}

function checkpoint(overrides: Partial<GraphCheckpoint> = {}): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: 'graph-main',
        reason: 'interrupt',
        queuedNodeIds: ['next-node'],
        completedNodeIds: ['start'],
        nodeStatuses: { start: 'succeeded', 'next-node': 'running' },
        attemptsByNodeId: { start: 1 },
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: 1,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 64,
        blackboardEntries: {},
        activeParallelParentIds: [],
        createdAt: TIMESTAMP,
        ...overrides,
    };
}

function createChatOutput(): ChatOutput & {
    readonly sticky: { value: string | null };
    readonly writes: string[];
} {
    const sticky = { value: null as string | null };
    const writes: string[] = [];
    return {
        writes,
        sticky,
        write: (text) => {
            writes.push(text);
        },
        setStickyNotice: (message) => {
            sticky.value = message;
        },
    };
}

describe('projectSessionAttachFromEvents', () => {
    it('projects graph id and sticky approval banner when a blocked run is resumable', () => {
        // Given: a completed node plus a blocked-on-approval run.
        const events: AgentEvent[] = [
            baseEvent('graph.started', { abg: { graphId: 'graph-main' } }),
            baseEvent('node.started', { abg: { graphId: 'graph-main', nodeId: 'start' } }),
            baseEvent('node.completed', { abg: { graphId: 'graph-main', nodeId: 'start' } }),
            baseEvent('run.blocked', {
                run: { runId: 'run-blocked', state: 'blocked_on_approval', toolCallId: 'tool-1' },
            }),
        ];

        // When: attach projection is derived from cold events.
        const projection = projectSessionAttachFromEvents(events);

        // Then: graph id and sticky approval banner are set; no turn is implied.
        expect(projection.graphId).toBe('graph-main');
        expect(projection.resumable).toMatchObject({ kind: 'approval', runId: 'run-blocked' });
        expect(projection.stickyBannerMessage).toBe(RESUMABLE_ATTACH_BANNER.approval);
        expect(projection.overlayRunState).toBe('blocked_on_approval');
    });

    it('projects interrupted sticky banner when checkpoint queue is non-empty', () => {
        // Given: an interrupted run with a usable checkpoint.
        const events: AgentEvent[] = [
            baseEvent('graph.started', { abg: { graphId: 'graph-main' } }),
            baseEvent('graph.checkpoint', {
                abg: { graphId: 'graph-main', checkpoint: checkpoint({ sessionRunId: 'run-int' }) },
                run: { runId: 'run-int' },
            }),
            baseEvent('run.interrupted', {
                run: { runId: 'run-int', state: 'interrupted', reason: 'provider_aborted' },
            }),
        ];

        // When: attach projection is derived.
        const projection = projectSessionAttachFromEvents(events);

        // Then: interrupted banner is sticky and graph id is present.
        expect(projection.graphId).toBe('graph-main');
        expect(projection.resumable?.kind).toBe('interrupted');
        expect(projection.stickyBannerMessage).toBe(RESUMABLE_ATTACH_BANNER.interrupted);
        expect(projection.overlayRunState).toBe('interrupted');
    });

    it('omits sticky banner when the latest run is idle completed', () => {
        // Given: a completed/idle terminal after prior graph activity.
        const events: AgentEvent[] = [
            baseEvent('graph.started', { abg: { graphId: 'graph-main' } }),
            baseEvent('node.completed', { abg: { graphId: 'graph-main', nodeId: 'start' } }),
            baseEvent('run.completed', { run: { runId: 'run-done', state: 'completed' } }),
            baseEvent('run.idle', { run: { runId: 'run-done', state: 'idle' } }),
        ];

        // When: attach projection is derived.
        const projection = projectSessionAttachFromEvents(events);

        // Then: ABG graph id may still project, but no sticky resumable banner.
        expect(projection.graphId).toBe('graph-main');
        expect(projection.resumable).toBeUndefined();
        expect(projection.stickyBannerMessage).toBeUndefined();
        expect(projection.overlayRunState).toBeUndefined();
    });
});

describe('applySessionAttachProjection', () => {
    it('projects ABG snapshot into the overlay and sets sticky banner without starting a turn', () => {
        // Given: interrupted events, an overlay controller, and sticky-capable output.
        const events: AgentEvent[] = [
            baseEvent('graph.started', { abg: { graphId: 'graph-main' } }),
            baseEvent('node.started', { abg: { graphId: 'graph-main', nodeId: 'start' } }),
            baseEvent('node.completed', { abg: { graphId: 'graph-main', nodeId: 'start' } }),
            baseEvent('node.started', { abg: { graphId: 'graph-main', nodeId: 'next-node' } }),
            baseEvent('graph.checkpoint', {
                abg: { graphId: 'graph-main', checkpoint: checkpoint({ sessionRunId: 'run-int' }) },
                run: { runId: 'run-int' },
            }),
            baseEvent('run.interrupted', {
                run: { runId: 'run-int', state: 'interrupted', reason: 'provider_aborted' },
            }),
        ];
        const controller = createAbgOverlayController(createAbgOverlayStore());
        const chatOutput = createChatOutput();
        const resumeTurn = vi.fn();
        const projection = projectSessionAttachFromEvents(events);

        // When: attach projection is applied.
        applySessionAttachProjection({
            events,
            projection,
            abgOverlayController: controller,
            chatOutput,
        });

        // Then: overlay reflects the graph snapshot, sticky banner is set, and no turn starts.
        const snap = controller.store.getSnapshot();
        expect(snap.activeGraphId).toBe('graph-main');
        expect(snap.nodes.get('start')).toBe('succeeded');
        expect(snap.nodes.get('next-node')).toBe('running');
        expect(snap.runState).toBe('interrupted');
        expect(chatOutput.sticky.value).toBe(RESUMABLE_ATTACH_BANNER.interrupted);
        expect(resumeTurn).not.toHaveBeenCalled();
    });

    it('restores the latest persisted context usage when attaching', () => {
        // Given: an attached graph emitted a completed LLM turn with input usage.
        const events: AgentEvent[] = [
            baseEvent('log', {
                abg: {
                    graphId: 'graph-main',
                    nodeId: 'llm-actor',
                    signalType: 'emit',
                    emit: {
                        type: 'llm.turn.completed',
                        payload: { text: 'done', usage: { inputTokens: 4200, outputTokens: 80 } },
                    },
                },
            }),
        ];
        const onUsage = vi.fn();
        const projection = projectSessionAttachFromEvents(events);

        // When: the cold session projection is attached.
        applySessionAttachProjection({
            events,
            projection,
            abgOverlayController: undefined,
            chatOutput: createChatOutput(),
            onUsage,
        });

        // Then: the status-bar input usage is restored from the durable event.
        expect(projection.contextTokensUsed).toBe(4200);
        expect(onUsage).toHaveBeenCalledExactlyOnceWith(4200);
    });

    it('restores cumulative cache-read usage for the attached session', () => {
        // Given: two durable graph turns with cache accounting.
        const events: AgentEvent[] = [
            baseEvent('log', {
                abg: {
                    graphId: 'graph-main',
                    nodeId: 'llm-actor',
                    signalType: 'emit',
                    emit: {
                        type: 'llm.turn.completed',
                        payload: {
                            text: 'first',
                            usage: { inputTokens: { total: 4000, noCache: 1000, cacheRead: 3000, cacheWrite: 0 } },
                        },
                    },
                },
            }),
            baseEvent('log', {
                abg: {
                    graphId: 'graph-main',
                    nodeId: 'llm-actor',
                    signalType: 'emit',
                    emit: {
                        type: 'llm.turn.completed',
                        payload: {
                            text: 'second',
                            usage: { inputTokens: { total: 8000, noCache: 3000, cacheRead: 5000, cacheWrite: 0 } },
                        },
                    },
                },
            }),
        ];
        const onContextCacheUsage = vi.fn();
        const projection = projectSessionAttachFromEvents(events);

        // When
        applySessionAttachProjection({
            events,
            projection,
            abgOverlayController: undefined,
            chatOutput: createChatOutput(),
            onContextCacheUsage,
        });

        // Then: cache ratio input is session-cumulative, not just the latest turn.
        expect(projection.contextCacheUsage).toEqual({ inputTokens: 12000, cacheReadTokens: 8000 });
        expect(onContextCacheUsage).toHaveBeenCalledExactlyOnceWith({
            inputTokens: 12000,
            cacheReadTokens: 8000,
        });
    });

    it('clears sticky banner when attach has no resumable run', () => {
        // Given: completed events and a previously sticky notice.
        const events: AgentEvent[] = [
            baseEvent('graph.started', { abg: { graphId: 'graph-main' } }),
            baseEvent('run.completed', { run: { runId: 'run-done', state: 'completed' } }),
        ];
        const chatOutput = createChatOutput();
        chatOutput.setStickyNotice?.(RESUMABLE_ATTACH_BANNER.approval);
        const projection = projectSessionAttachFromEvents(events);
        const onUsage = vi.fn();

        // When: attach projection is applied for a non-resumable session.
        applySessionAttachProjection({
            events,
            projection,
            abgOverlayController: undefined,
            chatOutput,
            onUsage,
        });

        // Then: sticky banner is cleared.
        expect(chatOutput.sticky.value).toBeNull();
        expect(onUsage).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it('clearStickyAttachBanner clears the sticky notice channel', () => {
        // Given: a sticky banner is currently shown.
        const chatOutput = createChatOutput();
        chatOutput.setStickyNotice?.(RESUMABLE_ATTACH_BANNER.interrupted);

        // When: the sticky banner is cleared (continue / next prompt).
        clearStickyAttachBanner(chatOutput);

        // Then: sticky notice is null.
        expect(chatOutput.sticky.value).toBeNull();
    });
});
