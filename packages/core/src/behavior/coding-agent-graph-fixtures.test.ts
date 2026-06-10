import type { AbgGraphSnapshot, AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { projectSessionReplay } from '../session-replay.js';
import { createAuthorableAbgGraph } from './authorable-graph.js';
import { runAbgGraph } from './graph-runner.js';
import { readFile } from 'node:fs/promises';

const root = process.cwd();
const timestamp = '2026-06-09T00:00:00.000Z';
const baseInput = {
    sessionId: 'session_coding_agent_fixture',
    now: () => timestamp,
    modelProviderSelection: {
        providerID: 'local',
        modelID: 'local-echo',
    },
} as const;

describe('coding-agent graph fixtures', () => {
    it('executes the approved coding-agent fixture and replays a graph snapshot with approvals and tool outcomes', async () => {
        const graph = await readGraphFixture('coding-agent.graph.json');
        const result = await runAbgGraph({
            ...baseInput,
            graph,
            graphInput: {
                events: [approvalDecisionEvent('coding-agent', 'approved')],
            },
        });
        const replay = projectSessionReplay({
            sessionId: baseInput.sessionId,
            envelopes: result.events.map((event, sequence) => envelope(event, sequence)),
        });
        const snapshot = requireGraphSnapshot(replay.graphSnapshots, 'coding-agent');

        expect(result.status).toBe('completed');
        expect(snapshot.status).toBe('completed');
        expect(nodeStatuses(snapshot)).toMatchObject({
            approval: 'succeeded',
            'patch-application': 'succeeded',
            'test-typecheck': 'succeeded',
            'final-summary': 'succeeded',
        });
        expect(snapshot.approvals).toMatchObject([
            {
                approvalId: 'approval_permission_coding-agent_approval',
                state: 'approved',
            },
        ]);
        expect(snapshot.toolOutcomes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ toolId: 'repo-analysis', status: 'completed' }),
                expect.objectContaining({ toolId: 'patch-application', status: 'completed' }),
                expect.objectContaining({ toolId: 'test-typecheck', status: 'completed' }),
            ]),
        );
        expect(replay.timeline.map((entry) => entry.nodeId)).toEqual(
            expect.arrayContaining(['chat-intake', 'repo-analysis', 'approval', 'final-summary']),
        );
    });

    it('replays the coding-agent fixture with a pending approval and no patch execution', async () => {
        const graph = await readGraphFixture('coding-agent.graph.json');
        const sessionId = 'session_coding_agent_pending_fixture';
        const result = await runAbgGraph({
            ...baseInput,
            sessionId,
            graph,
        });
        const replay = projectSessionReplay({
            sessionId,
            envelopes: result.events.map((event, sequence) => envelope({ ...event, sessionId }, sequence)),
        });
        const snapshot = requireGraphSnapshot(replay.graphSnapshots, 'coding-agent');

        expect(result.status).toBe('blocked');
        expect(snapshot.status).toBe('blocked');
        expect(nodeStatuses(snapshot)).toMatchObject({ approval: 'blocked' });
        expect(snapshot.approvals).toMatchObject([
            {
                approvalId: 'approval_permission_coding-agent_approval',
                state: 'pending',
            },
        ]);
        expect(snapshot.toolOutcomes).toEqual(
            expect.arrayContaining([expect.objectContaining({ toolId: 'repo-analysis', status: 'completed' })]),
        );
        expect(snapshot.toolOutcomes.map((tool) => tool.toolId)).not.toEqual(
            expect.arrayContaining(['patch-application', 'test-typecheck']),
        );
    });

    it('replays the policy-denied coding-agent fixture without executing patch or test nodes', async () => {
        const graph = await readGraphFixture('coding-agent-denied.graph.json');
        const sessionId = 'session_coding_agent_denied_fixture';
        const result = await runAbgGraph({
            ...baseInput,
            sessionId,
            graph,
            graphInput: {
                events: [approvalDecisionEvent('coding-agent-denied', 'approved')],
            },
        });
        const replay = projectSessionReplay({
            sessionId,
            envelopes: result.events.map((event, sequence) => envelope({ ...event, sessionId }, sequence)),
        });
        const snapshot = requireGraphSnapshot(replay.graphSnapshots, 'coding-agent-denied');

        expect(result.status).toBe('blocked');
        expect(snapshot.status).toBe('blocked');
        expect(nodeStatuses(snapshot)).toMatchObject({ approval: 'succeeded', 'patch-application': 'blocked' });
        expect(snapshot.approvals).toMatchObject([
            {
                approvalId: 'approval_permission_coding-agent-denied_approval',
                state: 'approved',
            },
        ]);
        expect(snapshot.nodes.map((node) => node.nodeId)).not.toEqual(
            expect.arrayContaining(['patch-application', 'test-typecheck']),
        );
        expect(snapshot.toolOutcomes.map((tool) => tool.toolId)).not.toEqual(
            expect.arrayContaining(['patch-application', 'test-typecheck']),
        );
    });
});

async function readGraphFixture(fileName: string): Promise<unknown> {
    const contents = await readFile(`${root}/examples/abg/${fileName}`, 'utf8');
    return createAuthorableAbgGraph(JSON.parse(contents));
}

function approvalDecisionEvent(graphId: string, state: 'approved' | 'denied') {
    return {
        id: `approval_${graphId}_${state}`,
        type: 'approval.updated',
        source: 'human',
        timestamp,
        payload: {
            approvalId: `approval_permission_${graphId}_approval`,
            state,
            reason: `${state} by fixture`,
        },
    };
}

function envelope(event: AgentEvent, sequence: number): AgentEventEnvelope {
    return {
        eventId: `fixture_event_${sequence}`,
        sequence,
        createdAt: event.timestamp,
        sessionId: event.sessionId ?? baseInput.sessionId,
        durability: 'durable',
        event,
    };
}

function requireGraphSnapshot(snapshots: readonly AbgGraphSnapshot[], graphId: string): AbgGraphSnapshot {
    const snapshot = snapshots.find((candidate) => candidate.graphId === graphId);
    if (snapshot === undefined) {
        throw new TypeError(`missing graph snapshot: ${graphId}`);
    }
    return snapshot;
}

function nodeStatuses(snapshot: AbgGraphSnapshot): Readonly<Record<string, string>> {
    return Object.fromEntries(snapshot.nodes.map((node) => [node.nodeId, node.status]));
}
