/**
 * Deterministic draft frontmatter writer (plan T3 / Must-have #4).
 *
 * Writes YAML frontmatter on `.mc/drafts/${plan.slug}.md` with status,
 * intent, and review_required from the blackboard. Optional dual-receipt
 * append when dual critic keys are present.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { isValidPlanSlug } from '../../persistence/plan-format';
import {
    appendDualReviewReceipts,
    type DraftScaffoldStatus,
    writeDraftFrontmatter,
} from '../../persistence/plan-scaffold';
import { createAbgEmitSignal } from '../abg-emit';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry';

const DRAFT_STATUSES = ['drafting', 'awaiting-approval', 'approved-writing'] as const;

export const runDraftFrontmatterNode: AbgNodeRunner = async function* (
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
                message: 'draft-frontmatter requires a blackboard',
            },
        };
        return;
    }

    const status = readStatus(node);
    if (status === undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: {
                code: 'invalid_config',
                message: 'draft-frontmatter requires config.status in drafting|awaiting-approval|approved-writing',
            },
        };
        return;
    }

    const slugValue = blackboard.get('plan.slug');
    if (typeof slugValue !== 'string' || slugValue.length === 0 || !isValidPlanSlug(slugValue)) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: {
                code: 'missing_plan_slug',
                message: 'draft-frontmatter requires a valid plan.slug on the blackboard',
            },
        };
        return;
    }

    const intentValue = blackboard.get('intent');
    const intent = typeof intentValue === 'string' && intentValue.length > 0 ? intentValue : undefined;
    const reviewRequired = blackboard.get('review_required') === true;
    const workspaceRoot = resolveWorkspaceRoot(context);

    const writeResult = await writeDraftFrontmatter(workspaceRoot, slugValue, {
        status,
        ...(intent !== undefined ? { intent } : {}),
        reviewRequired,
    });

    let receiptsAppended = false;
    if (readConfigBoolean(node, 'appendDualReceipts') === true) {
        const reviewer = stringifyBlackboard(blackboard.get('dual.reviewer'));
        const oracle = stringifyBlackboard(blackboard.get('dual.oracle'));
        const verdict = stringifyBlackboard(blackboard.get('dual.verdict'));
        if (reviewer !== undefined && oracle !== undefined && verdict !== undefined) {
            const attempt = readNonNegativeInt(blackboard.get('dual.fixes'));
            const receiptResult = await appendDualReviewReceipts(workspaceRoot, slugValue, {
                reviewer,
                oracle,
                verdict,
                attempt: attempt > 0 ? attempt : 1,
            });
            receiptsAppended = receiptResult.appended;
        }
    }

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'draft-frontmatter',
        eventType: 'draft_frontmatter.written',
        timestamp: context.now(),
        payload: {
            plan_slug: slugValue,
            status,
            intent: intent ?? null,
            review_required: reviewRequired,
            draft_path: writeResult.draftPath,
            created: writeResult.created,
            dual_receipts_appended: receiptsAppended,
        },
    });
    yield {
        type: 'success',
        nodeId,
        ...graphIdPart,
        result: {
            planSlug: slugValue,
            status,
            draftPath: writeResult.draftPath,
        },
    };
};

function readStatus(node: AbgNodeSpec): DraftScaffoldStatus | undefined {
    const value = node.config?.['status'];
    if (typeof value !== 'string') {
        return undefined;
    }
    return (DRAFT_STATUSES as readonly string[]).includes(value)
        ? (value as DraftScaffoldStatus)
        : undefined;
}

function readConfigBoolean(node: AbgNodeSpec, key: string): boolean | undefined {
    const value = node.config?.[key];
    return typeof value === 'boolean' ? value : undefined;
}

function stringifyBlackboard(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNonNegativeInt(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.trunc(value));
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
