/**
 * Deterministic planner resume-gate runner (plan T3).
 *
 * Reads `.omo/drafts/${plan.slug}.md` frontmatter and writes `resume_gate` ∈
 * `fresh` | `resume_approval` | `resume_drafting`. Never LLM-judged.
 *
 * Also applies intake-side pure fields when missing: `plan.slug` (kebab of goal
 * or `slug:<name>` token), `review_required` from high-accuracy markers, and
 * `interview.force` from interview-force markers ("interview me" / "ask me" /
 * "왜 안 물어"). On resume paths, frontmatter rehydrates `intent` and wins for
 * `review_required` when the current user message has no markers.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { isValidPlanSlug } from '../../persistence/plan-format';
import { omoFilePath } from '../../persistence/paths';
import { createAbgEmitSignal } from '../abg-emit';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry';
import {
    classifyResumeGate,
    derivePlanSlug,
    detectHighAccuracyMarkers,
    detectInterviewForce,
    parseDraftFrontmatter,
    rehydrateFromFrontmatter,
    type ResumeGateValue,
} from './resume-gate-helpers';
import { readFile } from 'node:fs/promises';

export {
    classifyResumeGate,
    derivePlanSlug,
    detectHighAccuracyMarkers,
    detectInterviewForce,
    DRAFT_STATUS_VALUES,
    HIGH_ACCURACY_MARKERS,
    INTERVIEW_FORCE_MARKERS,
    parseDraftFrontmatter,
    rehydrateFromFrontmatter,
    RESUME_GATE_VALUES,
    type DraftFrontmatter,
    type DraftFrontmatterParseResult,
    type DraftStatusValue,
    type ResumeGateValue,
    type ResumeRehydrateInput,
    type ResumeRehydrateOutput,
} from './resume-gate-helpers';

export const runResumeGateNode: AbgNodeRunner = async function* (
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
            error: { code: 'memory_unavailable', message: 'resume-gate requires a blackboard' },
        };
        return;
    }

    const userText = latestUserText(blackboard.getMessages()) ?? '';
    const markersPresent = detectHighAccuracyMarkers(userText);
    const interviewForce = detectInterviewForce(userText);

    const existingSlug = blackboard.get('plan.slug');
    const planSlug =
        typeof existingSlug === 'string' && existingSlug.length > 0 && isValidPlanSlug(existingSlug)
            ? existingSlug
            : derivePlanSlug(userText);
    blackboard.set('plan.slug', planSlug);

    if (blackboard.get('review_required') !== true) {
        blackboard.set('review_required', markersPresent);
    }

    if (blackboard.get('interview.force') !== true) {
        blackboard.set('interview.force', interviewForce);
    }

    const workspaceRoot = resolveWorkspaceRoot(context);
    const draftPath = omoFilePath(workspaceRoot, 'drafts', `${planSlug}.md`);

    let gate: ResumeGateValue = 'fresh';
    let diagnostic: { readonly code: string; readonly message: string } | undefined;

    const raw = await readOptionalUtf8(draftPath);
    if (raw !== undefined) {
        const parsed = parseDraftFrontmatter(raw);
        if (!parsed.ok) {
            gate = 'fresh';
            diagnostic = {
                code: 'corrupt_frontmatter',
                message: `draft frontmatter unusable (${parsed.reason}); treating as fresh`,
            };
        } else {
            const bodyNonEmpty = parsed.body.trim().length > 0;
            gate = classifyResumeGate(parsed.frontmatter.status, bodyNonEmpty);
            const rehydrated = rehydrateFromFrontmatter({
                gate,
                markersPresent,
                frontmatter: parsed.frontmatter,
            });
            if (rehydrated.intent !== undefined) {
                blackboard.set('intent', rehydrated.intent);
            }
            if (rehydrated.review_required !== undefined) {
                blackboard.set('review_required', rehydrated.review_required);
            }
        }
    }

    blackboard.set('resume_gate', gate);

    if (diagnostic !== undefined) {
        yield createAbgEmitSignal({
            graphId: context.graphId,
            nodeId,
            source: 'resume-gate',
            eventType: 'resume_gate.diagnostic',
            timestamp: context.now(),
            payload: diagnostic,
        });
    }

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'resume-gate',
        eventType: 'resume_gate.evaluated',
        timestamp: context.now(),
        payload: {
            resume_gate: gate,
            planSlug,
            review_required: blackboard.get('review_required') === true,
            markersPresent,
            interview_force: blackboard.get('interview.force') === true,
        },
    });
    yield { type: 'success', nodeId, ...graphIdPart, result: { resume_gate: gate, planSlug } };
};

function latestUserText(messages: readonly ModelMessage[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'user') {
            return messageText(message);
        }
    }
    return undefined;
}

function messageText(message: ModelMessage): string | undefined {
    const content = message.content;
    if (typeof content === 'string') {
        return content;
    }
    const text = content
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
    return text.length > 0 ? text : undefined;
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

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        // Fail-soft: missing or unreadable draft → fresh path (never crash the graph).
        if (isNodeFsError(error)) {
            return undefined;
        }
        throw error;
    }
}

function isNodeFsError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return false;
    }
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' && code.length > 0;
}
