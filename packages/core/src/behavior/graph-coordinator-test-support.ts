import type { AbgNodeSpec, AbgSignal, AgentEvent } from '@mission-control/protocol';
import type { AbgNodeRunContext, AbgNodeRunner } from './node-registry.js';

export function approvalGraph(id: string) {
    return {
        id,
        entryNodeId: 'approve',
        nodes: [{ id: 'approve', kind: 'human-approval' }],
        edges: [],
        rules: [],
        policies: [],
    };
}

type ApprovalInputEventInput = {
    readonly graphId: string;
    readonly eventType: string;
    readonly state: 'approved' | 'denied';
};

export function approvalInputEvent(input: ApprovalInputEventInput) {
    return {
        id: `event_${input.graphId}_${input.eventType}`,
        type: input.eventType,
        source: 'human',
        timestamp: '2026-06-09T00:00:00.000Z',
        payload: {
            approvalId: `approval_permission_${input.graphId}_approve`,
            state: input.state,
            reason: 'approved-looking payload',
        },
    };
}

type FanOutInput = {
    readonly id: string;
    readonly childKind: 'action' | 'tool';
    readonly implementation: string;
    readonly childCount: number;
    readonly capabilities?: readonly string[];
};

export function fanOutGraph(input: FanOutInput) {
    const children = Array.from({ length: input.childCount }, (_value, index) => `child-${index + 1}`);
    return {
        id: input.id,
        entryNodeId: 'start',
        nodes: [
            { id: 'start', kind: 'action' },
            ...children.map((id) => ({
                id,
                kind: input.childKind,
                implementation: input.implementation,
                ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
            })),
        ],
        edges: children.map((target) => ({ source: 'start', target })),
        rules: [],
        policies: [],
    };
}

export function createConcurrencyProbe() {
    const release = deferred<void>();
    const firstStarted = deferred<void>();
    let active = 0;
    let maxActive = 0;
    const startedNodeIds: string[] = [];
    const runner: AbgNodeRunner = async function* run(
        node: AbgNodeSpec,
        context: AbgNodeRunContext,
    ): AsyncIterable<AbgSignal> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        startedNodeIds.push(node.id);
        firstStarted.resolve();
        yield { type: 'started', graphId: context.graphId, nodeId: node.id };
        await release.promise;
        active -= 1;
        yield { type: 'success', graphId: context.graphId, nodeId: node.id };
    };
    return {
        firstStarted: firstStarted.promise,
        runner,
        release: release.resolve,
        maxActive: () => maxActive,
        startedNodeIds: () => [...startedNodeIds],
    };
}

function deferred<T>() {
    let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

export async function drainMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

export function waitingMessages(events: readonly AgentEvent[]): readonly string[] {
    return events.filter((event) => event.type === 'node.waiting').flatMap((event) => event.message ?? []);
}
