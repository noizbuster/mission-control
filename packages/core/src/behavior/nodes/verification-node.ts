/**
 * ABG Runner 4-phase verification node (plan Task 3.6).
 *
 * A composite DECISION node that aggregates four sequential verification phases and
 * emits a single APPROVE/REJECT verdict the graph can route on:
 *
 *   1. automated  — lsp_diagnostics / build / test results
 *   2. review     — human-style review of changed files
 *   3. qa         — bash/curl surface verification
 *   4. direct-read — plan re-read (does the work match the plan?)
 *
 * The node does NOT run real commands. Phase result inputs arrive via `node.config`
 * (each phase key holds a `VerificationPhaseInput` produced by upstream wave workers or
 * the test harness). The node's job is sequential execution + cumulative aggregation:
 * every enabled phase runs in order, findings from ALL phases are collected (no
 * short-circuit on first failure), and the verdict is APPROVE only when every enabled
 * phase passed. Disabled phases are skipped entirely and do not affect the verdict.
 *
 * The verdict is written to `verification.passed` / `verification.verdict` on the
 * Blackboard (when present) so rule-gated edges can route: APPROVE → continue,
 * REJECT → fix-loop.
 */
import type { AbgNodeSpec } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunner } from '../node-registry.js';

export type VerificationPhaseName = 'automated' | 'review' | 'qa' | 'direct-read';

export type VerificationPhaseResult = {
    readonly phase: VerificationPhaseName;
    readonly passed: boolean;
    readonly findings: readonly string[];
    readonly artifacts?: readonly string[];
};

/**
 * Phase result input as supplied in `node.config` — the upstream wave (or test harness)
 * produces this after running the real checks. The node normalizes it into a
 * `VerificationPhaseResult`.
 */
export type VerificationPhaseInput = {
    readonly passed: boolean;
    readonly findings?: readonly string[];
    readonly artifacts?: readonly string[];
};

export type VerificationNodeConfig = {
    readonly runAutomated: boolean;
    readonly runReview: boolean;
    readonly runQa: boolean;
    readonly runDirectRead: boolean;
};

export type VerificationVerdict = {
    readonly verdict: 'APPROVE' | 'REJECT';
    readonly results: readonly VerificationPhaseResult[];
    readonly findings: readonly string[];
};

type PhaseSlot = {
    readonly name: VerificationPhaseName;
    readonly enabled: boolean;
    readonly input: VerificationPhaseInput | undefined;
};

export function createVerificationNodeRunner(): AbgNodeRunner {
    return runVerificationNode;
}

const runVerificationNode: AbgNodeRunner = async function* (node, context) {
    const nodeId = node.id;
    const graphIdPart = { graphId: context.graphId };
    yield { type: 'started', nodeId, ...graphIdPart };

    const config = readVerificationNodeConfig(node);
    const slots: readonly PhaseSlot[] = [
        { name: 'automated', enabled: config.runAutomated, input: readPhaseInput(node.config, 'automatedResult') },
        { name: 'review', enabled: config.runReview, input: readPhaseInput(node.config, 'reviewResult') },
        { name: 'qa', enabled: config.runQa, input: readPhaseInput(node.config, 'qaResult') },
        { name: 'direct-read', enabled: config.runDirectRead, input: readPhaseInput(node.config, 'directReadResult') },
    ];

    const results: VerificationPhaseResult[] = [];
    for (const slot of slots) {
        if (!slot.enabled) {
            continue;
        }
        const result = executeVerificationPhase(slot);
        results.push(result);
        yield createAbgEmitSignal({
            graphId: context.graphId,
            nodeId,
            source: 'verification',
            eventType: 'verification.phase.completed',
            timestamp: context.now(),
            payload: { phase: result.phase, passed: result.passed, findings: result.findings },
        });
    }

    const verdict = aggregateVerificationVerdict(results);

    if (context.blackboard !== undefined) {
        context.blackboard.set('verification.passed', verdict.verdict === 'APPROVE');
        context.blackboard.set('verification.verdict', verdict.verdict);
        context.blackboard.set('verification.results', verdict.results);
    }

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'verification',
        eventType: 'verification.evaluated',
        timestamp: context.now(),
        payload: verdict,
    });
    yield { type: 'success', nodeId, ...graphIdPart, result: verdict };
};

/** Normalize a phase slot into a result. Missing input for an enabled phase = failure. */
export function executeVerificationPhase(slot: PhaseSlot): VerificationPhaseResult {
    const input = slot.input;
    if (input === undefined) {
        return {
            phase: slot.name,
            passed: false,
            findings: [`${slot.name} phase enabled but no result provided`],
        };
    }
    return {
        phase: slot.name,
        passed: input.passed,
        findings: input.findings ?? [],
        ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
    };
}

/** APPROVE iff every result passed; findings accumulate across all results. */
export function aggregateVerificationVerdict(results: readonly VerificationPhaseResult[]): VerificationVerdict {
    return {
        verdict: results.every((result) => result.passed) ? 'APPROVE' : 'REJECT',
        results,
        findings: results.flatMap((result) => result.findings),
    };
}

function readVerificationNodeConfig(node: AbgNodeSpec): VerificationNodeConfig {
    const config = node.config ?? {};
    return {
        runAutomated: readBoolean(config, 'runAutomated', true),
        runReview: readBoolean(config, 'runReview', true),
        runQa: readBoolean(config, 'runQa', true),
        runDirectRead: readBoolean(config, 'runDirectRead', true),
    };
}

function readBoolean(config: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
    const value = config[key];
    return typeof value === 'boolean' ? value : fallback;
}

function readPhaseInput(
    config: Readonly<Record<string, unknown>> | undefined,
    key: string,
): VerificationPhaseInput | undefined {
    if (config === undefined) {
        return undefined;
    }
    const raw = config[key];
    if (!isPhaseInputRecord(raw)) {
        return undefined;
    }
    const passedValue = raw.passed;
    if (typeof passedValue !== 'boolean') {
        return undefined;
    }
    const findings = isReadonlyStringArray(raw.findings) ? raw.findings : undefined;
    const artifacts = isReadonlyStringArray(raw.artifacts) ? raw.artifacts : undefined;
    return {
        passed: passedValue,
        ...(findings !== undefined ? { findings } : {}),
        ...(artifacts !== undefined ? { artifacts } : {}),
    };
}

type PhaseInputRecord = { readonly passed: unknown; readonly findings?: unknown; readonly artifacts?: unknown };

function isPhaseInputRecord(value: unknown): value is PhaseInputRecord {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    return 'passed' in value;
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export type { AbgNodeRunner };
