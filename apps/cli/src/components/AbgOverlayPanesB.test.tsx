import { describe, expect, test } from 'vitest';
import { type AbgOverlayStore, createAbgOverlayStore } from '../commands/abg-overlay-state.js';

function createMockStore(): AbgOverlayStore {
    return createAbgOverlayStore();
}

function populateStoreWithTools(store: AbgOverlayStore): void {
    store.update((draft) => {
        draft.toolOutcomes = [
            {
                toolId: 'tool-1',
                status: 'started',
                startedAt: '2026-06-20T10:00:00.000Z',
                lastMessage: 'Starting tool execution',
            },
            {
                toolId: 'tool-2',
                status: 'completed',
                startedAt: '2026-06-20T10:01:00.000Z',
                completedAt: '2026-06-20T10:02:00.000Z',
                lastMessage: 'Tool completed successfully',
            },
            {
                toolId: 'tool-3',
                status: 'failed',
                startedAt: '2026-06-20T10:03:00.000Z',
                failedAt: '2026-06-20T10:04:00.000Z',
                lastMessage: 'Tool failed with error',
            },
        ];
    });
}

function populateStoreWithTimeline(store: AbgOverlayStore): void {
    store.update((draft) => {
        draft.recentEvents = [
            {
                timestamp: '2026-06-20T10:00:00.000Z',
                type: 'graph.started',
                nodeId: 'node-1',
                signal: 'started',
                message: '',
            },
            {
                timestamp: '2026-06-20T10:01:00.000Z',
                type: 'node.progress',
                nodeId: 'node-1',
                signal: 'progress',
                message: 'Processing',
            },
            {
                timestamp: '2026-06-20T10:02:00.000Z',
                type: 'model.call.completed',
                nodeId: 'node-2',
                signal: 'emit',
                message: '',
                emitPayloadText: 'Model call completed',
            },
            {
                timestamp: '2026-06-20T10:03:00.000Z',
                type: 'policy.blocked',
                nodeId: 'node-3',
                signal: 'emit',
                message: 'Policy blocked action',
            },
            {
                timestamp: '2026-06-20T10:04:00.000Z',
                type: 'node.completed',
                nodeId: 'node-1',
                signal: 'success',
                message: '',
            },
        ];
    });
}

function populateStoreWithApprovals(store: AbgOverlayStore): void {
    store.update((draft) => {
        draft.pendingApprovals = [
            {
                approvalId: 'approval-1',
                requestId: 'request-1',
                policyDecision: 'requires_approval',
                state: 'pending',
                subject: { kind: 'tool', id: 'bash.run' },
                requestedAt: '2026-06-20T10:00:00.000Z',
                reason: 'Requires approval for bash execution',
            },
            {
                approvalId: 'approval-2',
                requestId: 'request-2',
                policyDecision: 'requires_approval',
                state: 'approved',
                subject: { kind: 'tool', id: 'file.write' },
                requestedAt: '2026-06-20T09:00:00.000Z',
                decidedAt: '2026-06-20T09:01:00.000Z',
                reason: 'File write approved',
            },
            {
                approvalId: 'approval-3',
                requestId: 'request-3',
                policyDecision: 'deny',
                state: 'denied',
                subject: { kind: 'tool', id: 'command.run' },
                requestedAt: '2026-06-20T08:00:00.000Z',
                decidedAt: '2026-06-20T08:01:00.000Z',
            },
        ];
    });
}

function populateStoreWithCost(store: AbgOverlayStore): void {
    store.update((draft) => {
        draft.costCents = 4;
        draft.inputTokens = 1234;
        draft.outputTokens = 567;
        draft.modelCalls = 3;
    });
}

describe('AbgOverlayPanesB - ToolsPane', () => {
    test('renders empty state when no tool outcomes', () => {
        const store = createMockStore();
        const state = store.getSnapshot();
        expect(state.toolOutcomes).toHaveLength(0);
    });

    test('renders tool outcomes with correct status glyphs', () => {
        const store = createMockStore();
        populateStoreWithTools(store);
        const state = store.getSnapshot();

        expect(state.toolOutcomes).toHaveLength(3);
        expect(state.toolOutcomes[0]?.status).toBe('started');
        expect(state.toolOutcomes[1]?.status).toBe('completed');
        expect(state.toolOutcomes[2]?.status).toBe('failed');
    });

    test('tool outcomes have truncated toolId and lastMessage', () => {
        const store = createMockStore();
        const longToolId = 'very-long-tool-identifier-that-exceeds-twenty-chars';
        const longMessage =
            'This is a very long message that should be truncated to sixty characters for display purposes';

        store.update((draft) => {
            draft.toolOutcomes = [
                {
                    toolId: longToolId,
                    status: 'started',
                    lastMessage: longMessage,
                },
            ];
        });

        const state = store.getSnapshot();
        const outcome = state.toolOutcomes[0];
        expect(outcome).toBeDefined();
        expect(outcome?.toolId).toBe(longToolId);
        expect(outcome?.lastMessage).toBe(longMessage);
    });
});

describe('AbgOverlayPanesB - TimelinePane', () => {
    test('renders empty state when no recent events', () => {
        const store = createMockStore();
        const state = store.getSnapshot();
        expect(state.recentEvents).toHaveLength(0);
    });

    test('renders recent events with correct structure', () => {
        const store = createMockStore();
        populateStoreWithTimeline(store);
        const state = store.getSnapshot();

        expect(state.recentEvents).toHaveLength(5);
        expect(state.recentEvents[0]?.type).toBe('graph.started');
        expect(state.recentEvents[1]?.type).toBe('node.progress');
        expect(state.recentEvents[2]?.type).toBe('model.call.completed');
        expect(state.recentEvents[3]?.type).toBe('policy.blocked');
        expect(state.recentEvents[4]?.type).toBe('node.completed');
    });

    test('recent events can hold up to 200 events', () => {
        const store = createMockStore();
        const events = Array.from({ length: 200 }, (_, i) => ({
            timestamp: `2026-06-20T10:00:${i.toString().padStart(2, '0')}.000Z`,
            type: `event-${i}`,
            message: `Message ${i}`,
        }));

        store.update((draft) => {
            draft.recentEvents = events;
        });

        const state = store.getSnapshot();
        expect(state.recentEvents.length).toBe(200);
    });
});

describe('AbgOverlayPanesB - ApprovalsPane', () => {
    test('renders empty state when no pending approvals', () => {
        const store = createMockStore();
        const state = store.getSnapshot();
        expect(state.pendingApprovals).toHaveLength(0);
    });

    test('renders approvals with correct state colors', () => {
        const store = createMockStore();
        populateStoreWithApprovals(store);
        const state = store.getSnapshot();

        expect(state.pendingApprovals).toHaveLength(3);
        expect(state.pendingApprovals[0]?.state).toBe('pending');
        expect(state.pendingApprovals[1]?.state).toBe('approved');
        expect(state.pendingApprovals[2]?.state).toBe('denied');
    });

    test('approval subject has kind and id', () => {
        const store = createMockStore();
        populateStoreWithApprovals(store);
        const state = store.getSnapshot();

        const approval = state.pendingApprovals[0];
        expect(approval).toBeDefined();
        expect(approval?.subject.kind).toBe('tool');
        expect(approval?.subject.id).toBe('bash.run');
    });
});

describe('AbgOverlayPanesB - CostPolicyPane', () => {
    test('renders default config (Metis 1.4) with zeros', () => {
        const store = createMockStore();
        const state = store.getSnapshot();

        expect(state.costCents).toBeUndefined();
        expect(state.inputTokens).toBe(0);
        expect(state.outputTokens).toBe(0);
        expect(state.modelCalls).toBe(0);
    });

    test('renders cost summary with accumulated usage', () => {
        const store = createMockStore();
        populateStoreWithCost(store);
        const state = store.getSnapshot();

        expect(state.costCents).toBe(4);
        expect(state.inputTokens).toBe(1234);
        expect(state.outputTokens).toBe(567);
        expect(state.modelCalls).toBe(3);
    });

    test('filters policy events from recent events', () => {
        const store = createMockStore();
        populateStoreWithTimeline(store);
        const state = store.getSnapshot();

        const policyEvents = state.recentEvents.filter(
            (e) =>
                e.type === 'policy.blocked' ||
                e.type === 'policy.evaluated' ||
                e.type === 'policy.budget.accumulated' ||
                e.type === 'policy.budget.warning' ||
                e.type === 'policy.budget.exceeded',
        );

        expect(policyEvents).toHaveLength(1);
        expect(policyEvents[0]?.type).toBe('policy.blocked');
    });

    test('renders no policy events when none present', () => {
        const store = createMockStore();
        store.update((draft) => {
            draft.recentEvents = [
                {
                    timestamp: '2026-06-20T10:00:00.000Z',
                    type: 'graph.started',
                    message: '',
                },
            ];
        });

        const state = store.getSnapshot();
        const policyEvents = state.recentEvents.filter(
            (e) =>
                e.type === 'policy.blocked' ||
                e.type === 'policy.evaluated' ||
                e.type === 'policy.budget.accumulated' ||
                e.type === 'policy.budget.warning' ||
                e.type === 'policy.budget.exceeded',
        );

        expect(policyEvents).toHaveLength(0);
    });
});

describe('AbgOverlayPanesB - Integration', () => {
    test('all panes can read from the same store state', () => {
        const store = createMockStore();
        populateStoreWithTools(store);
        populateStoreWithTimeline(store);
        populateStoreWithApprovals(store);
        populateStoreWithCost(store);

        const state = store.getSnapshot();

        expect(state.toolOutcomes.length).toBeGreaterThan(0);
        expect(state.recentEvents.length).toBeGreaterThan(0);
        expect(state.pendingApprovals.length).toBeGreaterThan(0);
        expect(state.modelCalls).toBeGreaterThan(0);
    });

    test('store updates propagate to all pane data', () => {
        const store = createMockStore();

        store.update((draft) => {
            draft.toolOutcomes = [
                {
                    toolId: 'tool-1',
                    status: 'started',
                },
            ];
        });

        let state = store.getSnapshot();
        expect(state.toolOutcomes).toHaveLength(1);

        store.update((draft) => {
            draft.toolOutcomes = [
                {
                    toolId: 'tool-1',
                    status: 'completed',
                },
                {
                    toolId: 'tool-2',
                    status: 'started',
                },
            ];
        });

        state = store.getSnapshot();
        expect(state.toolOutcomes).toHaveLength(2);
    });
});
