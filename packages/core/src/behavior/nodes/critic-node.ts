/**
 * ABG Critic node (ABG §10.6, Phase 6).
 *
 * Evaluates the latest assistant draft against quality checks and emits a verdict
 * (`critic.evaluated`), setting `critic.passed` on the Blackboard so rule-gated edges can
 * route: pass → finalize, fail → re-enter `LLMActor` to revise (the Draft→Critic→QualityGate
 * loop).
 *
 * Phase 6 uses a deterministic HEURISTIC critic (checks the draft is non-empty, cites evidence
 * like a `file:line` reference, isn't an obvious non-answer) so the verdict is reproducible. A
 * `CriticStrategy` seam lets a later phase swap in an LLM-based critic (which would call the
 * model with an evaluation prompt) without changing the node or its routing.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { Blackboard } from '../../memory/blackboard.js';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry.js';

export type CriticIssue = {
    readonly check: string;
    readonly message: string;
};

export type CriticVerdict = {
    readonly passed: boolean;
    readonly issues: readonly CriticIssue[];
};

export type CriticStrategy = {
    readonly name: string;
    evaluate(draft: string): CriticIssue[];
};

/** Default heuristic checks: a useful draft is non-empty, cites evidence, and isn't a non-answer. */
export const defaultCriticChecks: readonly CriticStrategy[] = [
    {
        name: 'non_empty',
        evaluate: (draft) => (draft.trim().length === 0 ? [{ check: 'non_empty', message: 'the draft is empty' }] : []),
    },
    {
        name: 'cites_evidence',
        evaluate: (draft) =>
            /\b[\w./-]+\.(ts|js|tsx|jsx|json|md|py|rs|go|java):\d+\b/.test(draft) || /\bfile_path:\d+\b/.test(draft)
                ? []
                : [{ check: 'cites_evidence', message: 'the draft cites no file:line evidence for its claims' }],
    },
    {
        name: 'not_non_answer',
        evaluate: (draft) =>
            /^(i don'?t know|i cannot|i can'?t|idk)\b/i.test(draft.trim())
                ? [{ check: 'not_non_answer', message: 'the draft is a non-answer; revise or escalate' }]
                : [],
    },
];

export const runCriticNode: AbgNodeRunner = async function* (
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
            error: { code: 'memory_unavailable', message: 'Critic requires a blackboard to read the draft' },
        };
        return;
    }

    const draft = latestAssistantText(blackboard);
    if (draft === undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: { code: 'critic_no_draft', message: 'no assistant draft on the blackboard to critique' },
        };
        return;
    }

    const checks = defaultCriticChecks;
    const issues = checks.flatMap((check) => check.evaluate(draft));
    const verdict: CriticVerdict = { passed: issues.length === 0, issues };

    blackboard.set('critic.passed', verdict.passed);
    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'critic',
        eventType: 'critic.evaluated',
        timestamp: context.now(),
        payload: { passed: verdict.passed, issues: verdict.issues, checksRun: checks.map((check) => check.name) },
    });
    yield { type: 'success', nodeId, ...graphIdPart, result: verdict };
};

function latestAssistantText(blackboard: Blackboard): string | undefined {
    const messages = blackboard.getMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'assistant') {
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

export type { AbgNodeRunner };
