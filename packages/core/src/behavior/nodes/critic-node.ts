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

// ---------------------------------------------------------------------------
// Verification-result mode (plan Task 3.7 — runner final verification wave)
//
// When a critic node carries `config.evaluateKey`, it runs in verification-result
// mode: it reads verification results from the blackboard at that key, normalizes
// them into typed pass/fail checks, aggregates them (APPROVE iff every check
// passed), and writes the verdict string to `config.outputKey` (and `critic.verdict`).
// This is how the runner workflow's F1–F4 parallel critics each produce an
// APPROVE/REJECT verdict the graph can route on.
//
// When `evaluateKey` is absent, the critic falls back to draft-heuristic mode
// (the Phase 6 Draft→Critic→QualityGate loop), preserving existing behavior.
// ---------------------------------------------------------------------------

/** A single normalized pass/fail check extracted from the evaluation input. */
export type CriticCheckResult = {
    readonly source: string;
    readonly passed: boolean;
    readonly findings: readonly string[];
};

/** Aggregated verdict for verification-result mode. */
export type CriticEvaluationVerdict = {
    readonly verdict: 'APPROVE' | 'REJECT';
    readonly checks: readonly CriticCheckResult[];
    readonly findings: readonly string[];
};

/**
 * Normalize an arbitrary blackboard value at `evaluateKey` into typed checks.
 * Accepts: bare boolean, a single result record (`{ passed }` or `{ verdict }`),
 * or an array of either. Unrecognized shapes become a single failing check so
 * the critic never silently APPROVEs garbage.
 */
export function normalizeEvaluationInput(value: unknown): readonly CriticCheckResult[] {
    if (value === undefined || value === null) {
        return [{ source: 'evaluateKey', passed: false, findings: ['no evaluation input at evaluateKey'] }];
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return [{ source: 'evaluateKey', passed: false, findings: ['evaluateKey held an empty array'] }];
        }
        return value.map((item, index) => normalizeEvaluationEntry(item, `evaluateKey[${index}]`));
    }
    return [normalizeEvaluationEntry(value, 'evaluateKey')];
}

/** APPROVE iff every check passed; findings accumulate across all checks. */
export function aggregateCriticEvaluation(results: readonly CriticCheckResult[]): CriticEvaluationVerdict {
    return {
        verdict: results.every((result) => result.passed) ? 'APPROVE' : 'REJECT',
        checks: results,
        findings: results.flatMap((result) => result.findings),
    };
}

function normalizeEvaluationEntry(value: unknown, source: string): CriticCheckResult {
    if (typeof value === 'boolean') {
        return { source, passed: value, findings: [] };
    }
    if (isPlainObject(value)) {
        const verdictValue = value['verdict'];
        if (typeof verdictValue === 'string') {
            return { source, passed: verdictValue === 'APPROVE', findings: readStringList(value['findings']) };
        }
        const passedValue = value['passed'];
        if (typeof passedValue === 'boolean') {
            return { source, passed: passedValue, findings: readStringList(value['findings']) };
        }
    }
    return { source, passed: false, findings: [`unrecognized evaluation input shape at ${source}`] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringList(value: unknown): readonly string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function readOptionalString(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = config[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

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

    const config = node.config ?? {};
    const evaluateKey = readOptionalString(config, 'evaluateKey');

    if (evaluateKey !== undefined) {
        yield* runVerificationResultCritic(nodeId, context, graphIdPart, evaluateKey, config);
        return;
    }

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

async function* runVerificationResultCritic(
    nodeId: string,
    context: AbgNodeRunContext,
    graphIdPart: { readonly graphId: string },
    evaluateKey: string,
    config: Readonly<Record<string, unknown>>,
): AsyncIterable<AbgSignal> {
    const blackboard = context.blackboard;
    if (blackboard === undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: {
                code: 'memory_unavailable',
                message: 'Critic verification mode requires a blackboard to read evaluateKey',
            },
        };
        return;
    }

    const rawValue = blackboard.get(evaluateKey);
    const checks = normalizeEvaluationInput(rawValue);
    const evaluation = aggregateCriticEvaluation(checks);

    const outputKey = readOptionalString(config, 'outputKey');
    if (outputKey !== undefined) {
        blackboard.set(outputKey, evaluation.verdict);
    }
    blackboard.set('critic.verdict', evaluation.verdict);
    blackboard.set('critic.passed', evaluation.verdict === 'APPROVE');

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'critic',
        eventType: 'critic.evaluated',
        timestamp: context.now(),
        payload: { mode: 'verification', ...evaluation },
    });
    yield { type: 'success', nodeId, ...graphIdPart, result: evaluation };
}

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
