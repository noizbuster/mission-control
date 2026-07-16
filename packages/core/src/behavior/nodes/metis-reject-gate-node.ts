/**
 * Deterministic planner metis-reject-gate runner (plan T5).
 *
 * Reads `metis.rejects` (default 0), applies pure `routeMetisReject`, writes
 * `metis.reject_route` ∈ `revise` | `escalate_present`, and increments the
 * counter only on the revise path. Never LLM-judged.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry';
import { PLANNER_METIS_REJECT_BUDGET, routeMetisReject } from '../planner-metis';

export {
    METIS_REJECT_ROUTE_VALUES,
    PLANNER_METIS_REJECT_BUDGET,
    routeMetisReject,
    type MetisRejectRoute,
} from '../planner-metis';

const DEFAULT_REJECT_KEY = 'metis.rejects';
const DEFAULT_ROUTE_KEY = 'metis.reject_route';

export const runMetisRejectGateNode: AbgNodeRunner = async function* (
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
                message: 'metis-reject-gate requires a blackboard',
            },
        };
        return;
    }

    const rejectKey = readConfigString(node, 'rejectKey') ?? DEFAULT_REJECT_KEY;
    const routeKey = readConfigString(node, 'outputKey') ?? DEFAULT_ROUTE_KEY;
    const budget = readConfigNumber(node, 'rejectBudget') ?? PLANNER_METIS_REJECT_BUDGET;

    const rejects = readNonNegativeInt(blackboard.get(rejectKey));
    const route = routeMetisReject(rejects, budget);

    blackboard.set(routeKey, route);

    let nextRejects = rejects;
    if (route === 'revise') {
        nextRejects = rejects + 1;
        blackboard.set(rejectKey, nextRejects);
    }

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'metis-reject-gate',
        eventType: 'metis_reject_gate.evaluated',
        timestamp: context.now(),
        payload: {
            metis_rejects: rejects,
            metis_rejects_after: nextRejects,
            reject_budget: budget,
            metis_reject_route: route,
        },
    });
    yield {
        type: 'success',
        nodeId,
        ...graphIdPart,
        result: {
            [routeKey]: route,
            [rejectKey]: nextRejects,
        },
    };
};

function readConfigString(node: AbgNodeSpec, key: string): string | undefined {
    const value = node.config?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readConfigNumber(node: AbgNodeSpec, key: string): number | undefined {
    const value = node.config?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeInt(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.trunc(value));
}
