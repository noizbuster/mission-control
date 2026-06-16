import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard.js';
import type { AbgNodeRunContext } from '../node-registry.js';
import {
    computeExponentialBackoffDelayMs,
    decideSupervisorAction,
    runSupervisorNode,
} from './supervisor-node.js';

const config = { target: 'llm-actor', maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000, escalationTarget: 'human-approval' };
const NOW = '2026-06-16T00:00:00.000Z';

describe('computeExponentialBackoffDelayMs', () => {
    it('doubles the delay each attempt and caps at maxDelayMs', () => {
        expect(computeExponentialBackoffDelayMs(1, 100, 1000)).toBe(100);
        expect(computeExponentialBackoffDelayMs(2, 100, 1000)).toBe(200);
        expect(computeExponentialBackoffDelayMs(3, 100, 1000)).toBe(400);
        expect(computeExponentialBackoffDelayMs(4, 100, 1000)).toBe(800);
        expect(computeExponentialBackoffDelayMs(5, 100, 1000)).toBe(1000); // 1600 capped to 1000
    });

    it('returns 0 for non-positive attempts', () => {
        expect(computeExponentialBackoffDelayMs(0, 100, 1000)).toBe(0);
    });

    it('does not cap when maxDelayMs is omitted', () => {
        expect(computeExponentialBackoffDelayMs(4, 100)).toBe(800);
    });
});

describe('decideSupervisorAction', () => {
    it('retries while attempts remain', () => {
        const d = decideSupervisorAction(1, config);
        expect(d.action).toBe('retry');
        expect(d.remaining).toBe(3);
        expect(d.delayMs).toBe(100);
    });

    it('escalates once attempts reach maxAttempts', () => {
        const d = decideSupervisorAction(4, config);
        expect(d.action).toBe('escalate');
        expect(d.remaining).toBe(0);
        expect(d.escalationTarget).toBe('human-approval');
    });

    it('clamps a malformed attempt count to >=1', () => {
        const d = decideSupervisorAction(-3, config);
        expect(d.attempt).toBe(1);
        expect(d.action).toBe('retry');
    });
});

function buildContext(blackboardAttempt?: number): { node: AbgNodeSpec; context: AbgNodeRunContext } {
    const blackboard = createBlackboard();
    if (blackboardAttempt !== undefined) {
        blackboard.set('supervisor.attempt', blackboardAttempt);
    }
    const node: AbgNodeSpec = {
        id: 'supervisor',
        kind: 'policy',
        implementation: 'supervisor',
        config: {
            target: config.target,
            maxAttempts: config.maxAttempts,
            baseDelayMs: config.baseDelayMs,
            maxDelayMs: config.maxDelayMs,
            escalationTarget: config.escalationTarget,
        },
    };
    const context = {
        graphId: 'graph-supervisor',
        now: () => NOW,
        blackboard,
    } as AbgNodeRunContext;
    return { node, context };
}

async function collect(node: AbgNodeSpec, context: AbgNodeRunContext): Promise<AbgSignal[]> {
    const out: AbgSignal[] = [];
    for await (const signal of runSupervisorNode(node, context)) {
        out.push(signal);
    }
    return out;
}

function errorCode(signal: AbgSignal): unknown {
    return signal.type === 'failure' ? signal.error : undefined;
}

describe('runSupervisorNode', () => {
    it('emits supervisor.backoff + supervisor.evaluated and retries below the limit', async () => {
        const { node, context } = buildContext(1);
        const out = await collect(node, context);
        const types = out.filter((s) => s.type === 'emit').map((s) => (s as { event: { type: string } }).event.type);
        expect(types).toContain('supervisor.backoff');
        expect(types).toContain('supervisor.evaluated');
        expect(out.some((s) => s.type === 'success')).toBe(true);
        expect(out.some((s) => s.type === 'escalate')).toBe(false);
    });

    it('emits an escalate signal (routed to escalationTarget) once attempts are exhausted', async () => {
        const { node, context } = buildContext(config.maxAttempts);
        const out = await collect(node, context);
        const escalate = out.find((s) => s.type === 'escalate');
        expect(escalate).toBeDefined();
        expect(escalate?.type === 'escalate' && escalate.target).toBe('human-approval');
        expect(context.blackboard?.get('supervisor.escalated')).toBe(true);
        expect(out.some((s) => s.type === 'success')).toBe(false);
    });

    it('fails fast when misconfigured (missing required config)', async () => {
        const blackboard = createBlackboard();
        const node: AbgNodeSpec = { id: 'supervisor', kind: 'policy', implementation: 'supervisor', config: { target: 'x' } };
        const context = { graphId: 'g', now: () => NOW, blackboard } as AbgNodeRunContext;
        const out = await collect(node, context);
        const failure = out.find((s) => s.type === 'failure');
        const error = failure === undefined ? undefined : errorCode(failure);
        expect(error).toMatchObject({ code: 'supervisor_misconfigured' });
    });
});
