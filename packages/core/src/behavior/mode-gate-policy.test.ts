import type { AbgSignal, PolicyEffectRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { workflowModePolicies } from '../workflows/materialize-workflow';
import { modeGatePolicy } from './graph-coordinator-helpers';
import { runAbgGraph } from './graph-runner';
import { autopilotMode } from './modes/autopilot-mode';
import { type AbgNodeRunContext, createAbgNodeRegistry } from './node-registry';
import { PLANNER_READONLY_POLICIES } from './planner-workflow-graph';

const baseInput = {
    sessionId: 'session_mode_gate',
    now: () => '2026-06-20T00:00:00.000Z',
    modelProviderSelection: {
        providerID: 'local',
        modelID: 'local-echo',
    },
} as const;

function modeGateGraph() {
    return {
        id: 'mode-gate-graph',
        entryNodeId: 'writer',
        nodes: [{ id: 'writer', kind: 'action' as const, implementation: 'tracking', capabilities: ['write'] }],
        edges: [],
        rules: [],
        policies: [],
    };
}

describe('modeGatePolicy — universal vs scoped split', () => {
    const writeNode = { id: 'writer', kind: 'llm' as const, capabilities: ['read', 'write'] };

    it('returns a deny policy for a universal deny rule', () => {
        const policy = modeGatePolicy(writeNode, [{ action: 'write', resource: '**', effect: 'deny' }]);
        expect(policy).toMatchObject({ capability: 'write', decision: 'deny' });
    });

    it('returns a requires_approval policy for autopilot edit → ask (universal)', () => {
        const policy = modeGatePolicy({ id: 'editor', kind: 'llm', capabilities: ['edit'] }, autopilotMode.policies);
        expect(policy).toMatchObject({ capability: 'edit', decision: 'requires_approval' });
    });

    it('last universal match wins and deny outranks ask across capabilities', () => {
        const rules: readonly PolicyEffectRule[] = [
            { action: 'write', resource: '**', effect: 'ask' },
            { action: 'bash', resource: '**', effect: 'deny' },
        ];
        const policy = modeGatePolicy({ id: 'multi', kind: 'llm', capabilities: ['write', 'bash'] }, rules);
        expect(policy).toMatchObject({ capability: 'bash', decision: 'deny' });
    });

    it('defers scoped rules to the tool layer: planner-readonly does NOT gate write nodes', () => {
        const policy = modeGatePolicy(writeNode, [...PLANNER_READONLY_POLICIES]);
        expect(policy).toBeUndefined();
    });

    it('returns undefined for no rules, empty capabilities, or universal allow', () => {
        expect(modeGatePolicy(writeNode, undefined)).toBeUndefined();
        expect(
            modeGatePolicy({ id: 'bare', kind: 'llm' }, [{ action: 'write', resource: '**', effect: 'deny' }]),
        ).toBeUndefined();
        expect(modeGatePolicy(writeNode, [{ action: 'write', resource: '**', effect: 'allow' }])).toBeUndefined();
    });
});

describe('workflowModePolicies — materialization seam', () => {
    it('returns undefined for a modeless workflow (default is untouched)', () => {
        expect(workflowModePolicies({ name: 'default', graph: modeGateGraph() })).toBeUndefined();
    });

    it('flattens the active modes rules in declaration order', () => {
        const policies = workflowModePolicies({
            name: 'planner',
            graph: modeGateGraph(),
            modes: [{ id: 'planner-readonly', policies: [...PLANNER_READONLY_POLICIES] }],
        });
        expect(policies).toEqual([...PLANNER_READONLY_POLICIES]);
    });
});

describe('mode gate enforcement through runAbgGraph', () => {
    function trackingRegistry(runs: string[]) {
        const registry = createAbgNodeRegistry();
        registry.register('tracking', async function* trackingNode(node, context: AbgNodeRunContext) {
            runs.push(node.id);
            yield { type: 'success', graphId: context.graphId, nodeId: node.id } satisfies AbgSignal;
        });
        return registry;
    }

    it('a universal deny blocks the node before it runs (policy_blocked)', async () => {
        const runs: string[] = [];
        const result = await runAbgGraph({
            ...baseInput,
            registry: trackingRegistry(runs),
            graph: modeGateGraph(),
            modePolicies: [{ action: 'write', resource: '**', effect: 'deny' }],
        });

        expect(result.status).toBe('blocked');
        expect(runs).toEqual([]);
        expect(result.events.map((event) => event.type)).toContain('policy.blocked');
        expect(result.events.at(-1)).toMatchObject({
            type: 'graph.failed',
            abg: { error: { code: 'policy_blocked' } },
        });
    });

    it('a universal ask blocks the node on the approval flow (approval.requested)', async () => {
        const runs: string[] = [];
        const result = await runAbgGraph({
            ...baseInput,
            registry: trackingRegistry(runs),
            graph: modeGateGraph(),
            modePolicies: [{ action: 'write', resource: '**', effect: 'ask' }],
        });

        expect(result.status).toBe('blocked');
        expect(runs).toEqual([]);
        expect(result.events.map((event) => event.type)).toContain('approval.requested');
    });

    it('scoped-only rules (planner-readonly) do not block the node at the gate', async () => {
        const runs: string[] = [];
        const result = await runAbgGraph({
            ...baseInput,
            registry: trackingRegistry(runs),
            graph: modeGateGraph(),
            modePolicies: [...PLANNER_READONLY_POLICIES],
        });

        expect(result.status).toBe('completed');
        expect(runs).toEqual(['writer']);
    });

    it('no modePolicies leaves the run unchanged', async () => {
        const runs: string[] = [];
        const result = await runAbgGraph({
            ...baseInput,
            registry: trackingRegistry(runs),
            graph: modeGateGraph(),
        });

        expect(result.status).toBe('completed');
        expect(runs).toEqual(['writer']);
    });
});
