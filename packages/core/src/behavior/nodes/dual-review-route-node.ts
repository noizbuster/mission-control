/**
 * Deterministic planner dual-review-route runner (plan T6).
 *
 * Reads `intent` + `review_required` (with ambiguity.classification fallback for
 * intent when the dedicated key is absent), applies pure `routeDualReview`, and
 * writes `dual.route` ∈ `skip` | `run`. Never LLM-judged. Fail-closed to `run`
 * when either key is missing after resolution.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry';
import { DUAL_INTENT_VALUES, routeDualReview, type DualIntent } from '../planner-dual-review';

export {
    DUAL_INTENT_VALUES,
    DUAL_ROUTE_VALUES,
    routeDualReview,
    type DualIntent,
    type DualRoute,
    type RouteDualReviewInput,
} from '../planner-dual-review';

const DEFAULT_ROUTE_KEY = 'dual.route';
const INTENT_KEY = 'intent';
const REVIEW_REQUIRED_KEY = 'review_required';
const AMBIGUITY_KEY = 'ambiguity.classification';

export const runDualReviewRouteNode: AbgNodeRunner = async function* (
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
                message: 'dual-review-route requires a blackboard',
            },
        };
        return;
    }

    const routeKey = readConfigString(node, 'outputKey') ?? DEFAULT_ROUTE_KEY;
    const intent = resolveIntent(blackboard.get(INTENT_KEY), blackboard.get(AMBIGUITY_KEY));
    const reviewRequired = resolveReviewRequired(blackboard.get(REVIEW_REQUIRED_KEY));

    // Persist resolved intent when derived from ambiguity.classification so
    // draft frontmatter and dual-fix re-entry see a stable key (decision 16).
    if (intent !== undefined && blackboard.get(INTENT_KEY) !== intent) {
        blackboard.set(INTENT_KEY, intent);
    }

    const route = routeDualReview({ intent, reviewRequired });
    blackboard.set(routeKey, route);

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'dual-review-route',
        eventType: 'dual_review_route.evaluated',
        timestamp: context.now(),
        payload: {
            intent: intent ?? null,
            review_required: reviewRequired ?? null,
            dual_route: route,
        },
    });
    yield {
        type: 'success',
        nodeId,
        ...graphIdPart,
        result: {
            [routeKey]: route,
            intent: intent ?? null,
            review_required: reviewRequired ?? null,
        },
    };
};

function resolveIntent(intentValue: unknown, ambiguityValue: unknown): DualIntent | undefined {
    if (isDualIntent(intentValue)) {
        return intentValue;
    }
    if (isDualIntent(ambiguityValue)) {
        return ambiguityValue;
    }
    return undefined;
}

function resolveReviewRequired(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function isDualIntent(value: unknown): value is DualIntent {
    return typeof value === 'string' && (DUAL_INTENT_VALUES as readonly string[]).includes(value);
}

function readConfigString(node: AbgNodeSpec, key: string): string | undefined {
    const value = node.config?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
