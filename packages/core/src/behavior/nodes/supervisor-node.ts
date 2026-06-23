/**
 * ABG Supervisor node (ABG §9, Phase 6 deferred item).
 *
 * A control node that supervises a failing action: on each visit it decides whether to
 * RETRY the target (after exponential backoff) or ESCALATE once attempts are exhausted.
 * It is a DECISION node, like the critic — it computes the verdict and emits observable
 * events; routing (re-enter the target, route to the escalation target) is the graph's job
 * via rule-gated edges. The escalate signal reuses the Phase-1 escalate routing
 * (`signal.target ?? node.config.escalationTarget`).
 *
 * Backoff is COMPUTED and emitted as data (`supervisor.backoff` with `delayMs`), never slept
 * inside the node — sleeping would inject real wall-clock into a deterministic graph. A
 * scheduler/runtime that honors the delay can read it; the schedule itself is the testable,
 * deterministic artifact.
 *
 * The node reads `supervisor.attempt` (1-based) from the Blackboard — incremented by the
 * graph each time the target fails and re-enters the supervisor — and config from `node.config`.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { Blackboard } from '../../memory/blackboard.js';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry.js';

export type SupervisorConfig = {
    readonly target: string;
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs?: number;
    /** Node to route to when attempts are exhausted (the escalate signal target). */
    readonly escalationTarget?: string;
};

export type SupervisorDecision = {
    readonly action: 'retry' | 'escalate';
    readonly attempt: number;
    readonly delayMs: number;
    readonly remaining: number;
    readonly target: string;
    readonly escalationTarget?: string;
};

/** Exponential backoff: base * 2^(attempt-1), capped at maxDelayMs. `attempt` is 1-based. */
export function computeExponentialBackoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs?: number): number {
    if (attempt < 1 || baseDelayMs < 0) {
        return 0;
    }
    // 2^(attempt-1) with a guard against overflow for pathological attempt counts.
    const exponent = Math.min(attempt - 1, 30);
    const delay = baseDelayMs * 2 ** exponent;
    if (maxDelayMs !== undefined) {
        return Math.min(delay, maxDelayMs);
    }
    return delay;
}

/**
 * Pure decision: retry while attempts remain, escalate once exhausted. The backoff delay
 * returned is the delay to apply BEFORE the next retry (or the final attempt's delay, for
 * observability, when escalating).
 */
export function decideSupervisorAction(attempt: number, config: SupervisorConfig): SupervisorDecision {
    const safeAttempt = Math.max(1, Math.trunc(attempt));
    const exhausted = safeAttempt >= config.maxAttempts;
    const delayMs = computeExponentialBackoffDelayMs(safeAttempt, config.baseDelayMs, config.maxDelayMs);
    return {
        action: exhausted ? 'escalate' : 'retry',
        attempt: safeAttempt,
        delayMs,
        remaining: Math.max(0, config.maxAttempts - safeAttempt),
        target: config.target,
        ...(config.escalationTarget !== undefined ? { escalationTarget: config.escalationTarget } : {}),
    };
}

export const runSupervisorNode: AbgNodeRunner = async function* (
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
): AsyncIterable<AbgSignal> {
    const nodeId = node.id;
    const graphIdPart = { graphId: context.graphId };
    yield { type: 'started', nodeId, ...graphIdPart };

    const blackboard = context.blackboard;
    if (blackboard === undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: {
                code: 'memory_unavailable',
                message: 'Supervisor requires a blackboard to read the attempt counter',
            },
        };
        return;
    }

    const config = readSupervisorConfig(node);
    if (config === undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: {
                code: 'supervisor_misconfigured',
                message: 'Supervisor node config requires target, maxAttempts, and baseDelayMs',
            },
        };
        return;
    }

    const attempt = readAttemptCounter(blackboard);
    const decision = decideSupervisorAction(attempt, config);

    blackboard.set('supervisor.attempt', attempt + 1);
    blackboard.set('supervisor.action', decision.action);

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'supervisor',
        eventType: 'supervisor.backoff',
        timestamp: context.now(),
        payload: { delayMs: decision.delayMs, attempt: decision.attempt, remaining: decision.remaining },
    });
    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'supervisor',
        eventType: 'supervisor.evaluated',
        timestamp: context.now(),
        payload: {
            action: decision.action,
            attempt: decision.attempt,
            target: decision.target,
            ...(decision.escalationTarget !== undefined ? { escalationTarget: decision.escalationTarget } : {}),
        },
    });

    if (decision.action === 'escalate') {
        blackboard.set('supervisor.escalated', true);
        yield { type: 'success', nodeId, ...graphIdPart, result: { ...decision, escalated: true } };
        return;
    }

    yield { type: 'success', nodeId, ...graphIdPart, result: decision };
};

function readSupervisorConfig(node: AbgNodeSpec): SupervisorConfig | undefined {
    const config = node.config;
    if (config === undefined) {
        return { target: 'retry', maxAttempts: 2, baseDelayMs: 1000 };
    }
    const target = typeof config['target'] === 'string' && config['target'].length > 0
        ? config['target']
        : 'retry';
    const maxAttemptsRaw = config['maxAttempts'];
    const maxAttempts = typeof maxAttemptsRaw === 'number' && Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw >= 1
        ? Math.trunc(maxAttemptsRaw)
        : 2;
    const baseDelayMsRaw = config['baseDelayMs'];
    const baseDelayMs = typeof baseDelayMsRaw === 'number' && Number.isFinite(baseDelayMsRaw) && baseDelayMsRaw >= 0
        ? baseDelayMsRaw
        : 1000;
    const maxDelayMs = config['maxDelayMs'];
    const escalationTarget = config['escalationTarget'];
    return {
        target,
        maxAttempts: Math.trunc(maxAttempts),
        baseDelayMs,
        ...(typeof maxDelayMs === 'number' && Number.isFinite(maxDelayMs) ? { maxDelayMs } : {}),
        ...(typeof escalationTarget === 'string' && escalationTarget.length > 0 ? { escalationTarget } : {}),
    };
}

function readAttemptCounter(blackboard: Blackboard): number {
    const value = blackboard.get('supervisor.attempt');
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 1;
    }
    return Math.max(1, Math.trunc(value));
}

export type { AbgNodeRunner };
