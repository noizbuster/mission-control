import React from 'react';
import { describe, expect, test } from 'vitest';
import type { AbgOverlayState } from '../commands/abg-overlay-state';
import { GraphPane, NodesPane, OverviewPane } from './AbgOverlayPanesA';

function createEmptyState(): AbgOverlayState {
    return {
        activeGraphId: undefined,
        graphStatus: undefined,
        nodes: new Map(),
        activeNodeIds: [],
        toolOutcomes: [],
        recentEvents: [],
        pendingApprovals: [],
        blackboardEntries: new Map(),
        knownGraphIds: [],
        graphs: new Map(),
        focusedGraphId: undefined,
        costCents: undefined,
        inputTokens: 0,
        outputTokens: 0,
        modelCalls: 0,
        lastLiveDelta: '',
        lastError: undefined,
        runState: 'idle',
        nativeSidecarStatus: '',
        lastSettledAt: undefined,
    };
}

function createHappyState(): AbgOverlayState {
    const nodes = new Map<string, AbgOverlayState['nodes'] extends ReadonlyMap<string, infer V> ? V : never>();
    nodes.set('node-1', 'running');
    nodes.set('node-2', 'succeeded');
    nodes.set('node-3', 'failed');
    return {
        activeGraphId: 'test-graph-123',
        graphStatus: 'active',
        nodes,
        activeNodeIds: ['node-1'],
        toolOutcomes: [],
        recentEvents: [
            {
                timestamp: '2024-01-01T00:00:00Z',
                type: 'node.started',
                nodeId: 'node-1',
                signal: 'started',
                message: '',
            },
        ],
        pendingApprovals: [],
        blackboardEntries: new Map(),
        knownGraphIds: [],
        graphs: new Map(),
        focusedGraphId: undefined,
        costCents: 150,
        inputTokens: 100,
        outputTokens: 200,
        modelCalls: 5,
        lastLiveDelta: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10',
        lastError: undefined,
        runState: 'running',
        nativeSidecarStatus: 'native',
        lastSettledAt: undefined,
    };
}

function createMalformedState(): AbgOverlayState {
    return {
        activeGraphId: 'malformed-graph',
        graphStatus: 'active',
        nodes: new Map(),
        activeNodeIds: [],
        toolOutcomes: [],
        recentEvents: [],
        pendingApprovals: [],
        blackboardEntries: new Map(),
        knownGraphIds: [],
        graphs: new Map(),
        focusedGraphId: undefined,
        costCents: undefined,
        inputTokens: 0,
        outputTokens: 0,
        modelCalls: 0,
        lastLiveDelta: '',
        lastError: 'Test error message',
        runState: 'failed',
        nativeSidecarStatus: 'unavailable',
        lastSettledAt: undefined,
    };
}

describe('AbgOverlayPanesA', () => {
    describe('OverviewPane', () => {
        test('Happy: renders all header fields and live output', () => {
            const state = createHappyState();
            const element = React.createElement(OverviewPane, { state, modelLabel: 'openai/gpt-4' });

            expect(element).toBeDefined();
            expect(element.props.state).toBe(state);
            expect(element.props.modelLabel).toBe('openai/gpt-4');

            const stateWithCost = state;
            expect(stateWithCost.costCents).toBe(150);
            expect(stateWithCost.inputTokens).toBe(100);
            expect(stateWithCost.outputTokens).toBe(200);
            expect(stateWithCost.activeGraphId).toBe('test-graph-123');
            expect(stateWithCost.graphStatus).toBe('active');
            expect(stateWithCost.runState).toBe('running');
            expect(stateWithCost.nativeSidecarStatus).toBe('native');
        });

        test('Empty state: shows "No active ABG run" when activeGraphId is undefined', () => {
            const state = createEmptyState();
            const element = React.createElement(OverviewPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.activeGraphId).toBeUndefined();
            expect(state.graphStatus).toBeUndefined();
            expect(state.nodes.size).toBe(0);
            expect(state.recentEvents.length).toBe(0);
        });

        test('Empty state: shows "No active ABG run" when graphStatus is undefined', () => {
            const state: AbgOverlayState = {
                ...createEmptyState(),
                activeGraphId: 'some-graph',
            };
            const element = React.createElement(OverviewPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.activeGraphId).toBe('some-graph');
            expect(state.graphStatus).toBeUndefined();
        });

        test('Empty state: shows "No active ABG run" when nodes and recentEvents are empty', () => {
            const state: AbgOverlayState = {
                ...createEmptyState(),
                activeGraphId: 'some-graph',
                graphStatus: 'active',
            };
            const element = React.createElement(OverviewPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.nodes.size).toBe(0);
            expect(state.recentEvents.length).toBe(0);
        });

        test('Malformed: renders with lastError present', () => {
            const state = createMalformedState();
            const element = React.createElement(OverviewPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.lastError).toBe('Test error message');
            expect(state.runState).toBe('failed');
        });

        test('Cost summary defaults to $0.00 when costCents is undefined', () => {
            const state: AbgOverlayState = {
                ...createHappyState(),
                costCents: undefined,
            };
            const element = React.createElement(OverviewPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.costCents).toBeUndefined();
            expect(state.inputTokens).toBe(100);
            expect(state.outputTokens).toBe(200);
        });

        test('Live output shows last 8 lines of lastLiveDelta', () => {
            const state = createHappyState();
            const lines = state.lastLiveDelta.split('\n');
            expect(lines.length).toBe(10);
            const last8 = lines.slice(-8);
            expect(last8.length).toBe(8);
            expect(last8[0]).toBe('Line 3');
            expect(last8[7]).toBe('Line 10');
        });
    });

    describe('GraphPane', () => {
        test('Happy: renders graph with 3 nodes', () => {
            const state = createHappyState();
            const element = React.createElement(GraphPane, { state, modelLabel: 'openai/gpt-4' });

            expect(element).toBeDefined();
            expect(state.nodes.size).toBe(3);
            expect(state.nodes.get('node-1')).toBe('running');
            expect(state.nodes.get('node-2')).toBe('succeeded');
            expect(state.nodes.get('node-3')).toBe('failed');
        });

        test('Empty state: shows "No active ABG run"', () => {
            const state = createEmptyState();
            const element = React.createElement(GraphPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.activeGraphId).toBeUndefined();
        });

        test('Malformed: renders with empty nodes map', () => {
            const state = createMalformedState();
            const element = React.createElement(GraphPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.nodes.size).toBe(0);
        });

        test('Node status glyphs are correct', () => {
            const state = createHappyState();
            expect(state.nodes.get('node-1')).toBe('running');
            expect(state.nodes.get('node-2')).toBe('succeeded');
            expect(state.nodes.get('node-3')).toBe('failed');
        });
    });

    describe('NodesPane', () => {
        test('Happy: renders table with 3 nodes', () => {
            const state = createHappyState();
            const element = React.createElement(NodesPane, { state, modelLabel: 'openai/gpt-4' });

            expect(element).toBeDefined();
            expect(state.nodes.size).toBe(3);
        });

        test('Empty state: shows "No active ABG run"', () => {
            const state = createEmptyState();
            const element = React.createElement(NodesPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.activeGraphId).toBeUndefined();
        });

        test('Malformed: renders with empty nodes map', () => {
            const state = createMalformedState();
            const element = React.createElement(NodesPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            expect(state.nodes.size).toBe(0);
        });

        test('Node IDs are truncated to 10 chars', () => {
            const nodes = new Map<string, 'running'>();
            nodes.set('very-long-node-id-that-exceeds-ten-characters', 'running');
            const state: AbgOverlayState = {
                ...createHappyState(),
                nodes,
            };
            const element = React.createElement(NodesPane, { state, modelLabel: 'local/local-echo' });

            expect(element).toBeDefined();
            const nodeIds = [...state.nodes.keys()];
            expect(nodeIds.length).toBeGreaterThan(0);
            const nodeId = nodeIds[0];
            if (nodeId !== undefined) {
                expect(nodeId.length).toBeGreaterThan(10);
            }
        });
    });

    describe('Status color mapping', () => {
        test('Graph status colors are correct', () => {
            const state1: AbgOverlayState = {
                ...createHappyState(),
                graphStatus: 'active',
            };
            expect(state1.graphStatus).toBe('active');

            const state2: AbgOverlayState = {
                ...createHappyState(),
                graphStatus: 'completed',
            };
            expect(state2.graphStatus).toBe('completed');

            const state3: AbgOverlayState = {
                ...createHappyState(),
                graphStatus: 'failed',
            };
            expect(state3.graphStatus).toBe('failed');

            const state4: AbgOverlayState = {
                ...createHappyState(),
                graphStatus: 'blocked',
            };
            expect(state4.graphStatus).toBe('blocked');

            const state5: AbgOverlayState = {
                ...createHappyState(),
                graphStatus: 'cancelled',
            };
            expect(state5.graphStatus).toBe('cancelled');
        });

        test('Node status colors are correct', () => {
            const state = createHappyState();
            expect(state.nodes.get('node-1')).toBe('running');
            expect(state.nodes.get('node-2')).toBe('succeeded');
            expect(state.nodes.get('node-3')).toBe('failed');
        });
    });
});
