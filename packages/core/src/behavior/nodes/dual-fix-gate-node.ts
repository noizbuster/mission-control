/**
 * Deterministic planner dual-fix-gate runner (plan T6).
 *
 * Reads `dual.fixes` (default 0), applies pure `routeFixDual`, writes
 * `dual.fix_route` ∈ `revise` | `escalate`, and on revise increments the
 * counter and resets `metis.rejects` to 0 (decision 18). Never LLM-judged.
 *
 * Receipts: appends `## Dual review receipts` on the draft when plan.slug is
 * set, and emits dual_fix_gate.evaluated with both critic verdicts + attempt.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { isValidPlanSlug } from '../../persistence/plan-format';
import { appendDualReviewReceipts } from '../../persistence/plan-scaffold';
import { createAbgEmitSignal } from '../abg-emit';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry';
import { PLANNER_DUAL_FIX_BUDGET, routeFixDual } from '../planner-dual-review';

export {
    DUAL_FIX_ROUTE_VALUES,
    PLANNER_DUAL_FIX_BUDGET,
    routeFixDual,
    type DualFixRoute,
} from '../planner-dual-review';

const DEFAULT_FIX_KEY = 'dual.fixes';
const DEFAULT_ROUTE_KEY = 'dual.fix_route';
const DEFAULT_METIS_REJECT_KEY = 'metis.rejects';

export const runDualFixGateNode: AbgNodeRunner = async function* (
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
                message: 'dual-fix-gate requires a blackboard',
            },
        };
        return;
    }

    const fixKey = readConfigString(node, 'fixKey') ?? DEFAULT_FIX_KEY;
    const routeKey = readConfigString(node, 'outputKey') ?? DEFAULT_ROUTE_KEY;
    const metisRejectKey = readConfigString(node, 'metisRejectKey') ?? DEFAULT_METIS_REJECT_KEY;
    const budget = readConfigNumber(node, 'fixBudget') ?? PLANNER_DUAL_FIX_BUDGET;

    const fixes = readNonNegativeInt(blackboard.get(fixKey));
    const route = routeFixDual(fixes, budget);

    blackboard.set(routeKey, route);

    let nextFixes = fixes;
    if (route === 'revise') {
        nextFixes = fixes + 1;
        blackboard.set(fixKey, nextFixes);
        // Decision 18: dual-fix rewrite gets one fresh gap-analysis chance.
        blackboard.set(metisRejectKey, 0);
    }

    const dualReviewer = blackboard.get('dual.reviewer');
    const dualOracle = blackboard.get('dual.oracle');
    const dualVerdict = blackboard.get('dual.verdict');
    const attempt = nextFixes > 0 ? nextFixes : 1;
    const receiptsAppended = await appendReceiptsIfPossible({
        context,
        blackboard,
        dualReviewer,
        dualOracle,
        dualVerdict,
        attempt,
    });

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'dual-fix-gate',
        eventType: 'dual_fix_gate.evaluated',
        timestamp: context.now(),
        payload: {
            dual_fixes: fixes,
            dual_fixes_after: nextFixes,
            fix_budget: budget,
            dual_fix_route: route,
            dual_reviewer: dualReviewer ?? null,
            dual_oracle: dualOracle ?? null,
            dual_verdict: dualVerdict ?? null,
            attempt,
            metis_rejects_reset: route === 'revise',
            dual_receipts_appended: receiptsAppended,
        },
    });
    yield {
        type: 'success',
        nodeId,
        ...graphIdPart,
        result: {
            [routeKey]: route,
            [fixKey]: nextFixes,
            ...(route === 'revise' ? { [metisRejectKey]: 0 } : {}),
        },
    };
};

async function appendReceiptsIfPossible(input: {
    readonly context: AbgNodeRunContext;
    readonly blackboard: NonNullable<AbgNodeRunContext['blackboard']>;
    readonly dualReviewer: unknown;
    readonly dualOracle: unknown;
    readonly dualVerdict: unknown;
    readonly attempt: number;
}): Promise<boolean> {
    const slugValue = input.blackboard.get('plan.slug');
    if (typeof slugValue !== 'string' || slugValue.length === 0 || !isValidPlanSlug(slugValue)) {
        return false;
    }
    const reviewer = typeof input.dualReviewer === 'string' ? input.dualReviewer : undefined;
    const oracle = typeof input.dualOracle === 'string' ? input.dualOracle : undefined;
    const verdict = typeof input.dualVerdict === 'string' ? input.dualVerdict : undefined;
    if (reviewer === undefined || oracle === undefined || verdict === undefined) {
        return false;
    }
    const workspaceRoot = resolveWorkspaceRoot(input.context);
    try {
        const result = await appendDualReviewReceipts(workspaceRoot, slugValue, {
            reviewer,
            oracle,
            verdict,
            attempt: input.attempt,
        });
        return result.appended;
    } catch (error: unknown) {
        if (isNodeFsError(error) || isPlanScaffoldError(error)) {
            return false;
        }
        throw error;
    }
}

function resolveWorkspaceRoot(context: AbgNodeRunContext): string {
    const env = context.systemPromptEnv;
    if (env?.workspaceRoot !== undefined && env.workspaceRoot.length > 0) {
        return env.workspaceRoot;
    }
    if (env?.cwd !== undefined && env.cwd.length > 0) {
        return env.cwd;
    }
    return process.cwd();
}

function isNodeFsError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return false;
    }
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' && code.length > 0;
}

function isPlanScaffoldError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('name' in error)) {
        return false;
    }
    const name = Reflect.get(error, 'name');
    return name === 'PlanScaffoldError' || name === 'DraftFrontmatterError';
}

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
