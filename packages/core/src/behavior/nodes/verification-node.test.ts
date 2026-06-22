import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard.js';
import {
    aggregateVerificationVerdict,
    createVerificationNodeRunner,
    executeVerificationPhase,
    type VerificationPhaseResult,
    type VerificationVerdict,
} from './verification-node.js';

const NOW = '2026-06-22T00:00:00.000Z';
const runner = createVerificationNodeRunner();

type Blackboard = ReturnType<typeof createBlackboard>;

function contextWith(blackboard: Blackboard | undefined) {
    return { graphId: 'g1', now: () => NOW, ...(blackboard !== undefined ? { blackboard } : {}) };
}

function makeNode(config: Record<string, unknown>): AbgNodeSpec {
    return { id: 'verify', kind: 'condition', config };
}

type Collected = {
    readonly signals: readonly AbgSignal[];
    readonly verdict: VerificationVerdict | undefined;
    readonly evaluated: Extract<AbgSignal, { type: 'emit' }> | undefined;
    readonly phaseEmits: readonly Extract<AbgSignal, { type: 'emit' }>[];
};

async function runVerification(
    config: Record<string, unknown>,
    blackboard: Blackboard | undefined = createBlackboard(),
): Promise<Collected> {
    const signals: AbgSignal[] = [];
    for await (const signal of runner(makeNode(config), contextWith(blackboard))) {
        signals.push(signal);
    }
    const success = signals.find((s): s is Extract<AbgSignal, { type: 'success' }> => s.type === 'success');
    const verdict = success?.result as VerificationVerdict | undefined;
    const emitSignals = signals.filter((s): s is Extract<AbgSignal, { type: 'emit' }> => s.type === 'emit');
    const evaluated = emitSignals.find((signal) => signal.event.type === 'verification.evaluated');
    const phaseEmits = emitSignals.filter((signal) => signal.event.type === 'verification.phase.completed');
    return { signals, verdict, evaluated, phaseEmits };
}

const ALL_ENABLED = {
    runAutomated: true,
    runReview: true,
    runQa: true,
    runDirectRead: true,
} as const;

describe('createVerificationNodeRunner', () => {
    it('returns APPROVE when all enabled phases pass', async () => {
        const { verdict, phaseEmits, evaluated } = await runVerification({
            ...ALL_ENABLED,
            automatedResult: { passed: true, artifacts: ['/tmp/build.log', '/tmp/test-output.txt'] },
            reviewResult: { passed: true, findings: [] },
            qaResult: { passed: true, findings: ['curl localhost:3000/health -> 200'] },
            directReadResult: { passed: true },
        });
        expect(verdict?.verdict).toBe('APPROVE');
        expect(verdict?.findings).toEqual(['curl localhost:3000/health -> 200']);
        expect(verdict?.results).toHaveLength(4);
        expect(phaseEmits).toHaveLength(4);
        expect((evaluated?.event.payload as { verdict: string }).verdict).toBe('APPROVE');
    });

    it('returns REJECT with cumulative findings when one phase fails', async () => {
        const { verdict } = await runVerification({
            ...ALL_ENABLED,
            automatedResult: { passed: false, findings: ['tsc: error TS2345', 'tsc: error TS2307'] },
            reviewResult: { passed: true },
            qaResult: { passed: true },
            directReadResult: { passed: true },
        });
        expect(verdict?.verdict).toBe('REJECT');
        expect(verdict?.findings).toEqual(['tsc: error TS2345', 'tsc: error TS2307']);
        expect(verdict?.results.filter((result) => !result.passed)).toHaveLength(1);
        expect(verdict?.results.find((result) => !result.passed)?.phase).toBe('automated');
    });

    it('skips disabled phases and does not count them against the verdict', async () => {
        const { verdict, phaseEmits } = await runVerification({
            runAutomated: true,
            runReview: false,
            runQa: true,
            runDirectRead: false,
            automatedResult: { passed: true },
            // reviewResult intentionally omitted — phase is disabled
            qaResult: { passed: true },
            // directReadResult intentionally omitted — phase is disabled
        });
        expect(verdict?.verdict).toBe('APPROVE');
        expect(verdict?.results).toHaveLength(2);
        expect(verdict?.results.map((result) => result.phase)).toEqual(['automated', 'qa']);
        expect(phaseEmits).toHaveLength(2);
    });

    it('aggregates findings from multiple failing phases', async () => {
        const { verdict } = await runVerification({
            ...ALL_ENABLED,
            automatedResult: { passed: false, findings: ['build failed', '3 tests failed'] },
            reviewResult: { passed: false, findings: ['unused import in auth.ts'] },
            qaResult: { passed: true },
            directReadResult: { passed: false, findings: ['plan step 2 not implemented'] },
        });
        expect(verdict?.verdict).toBe('REJECT');
        expect(verdict?.findings).toEqual([
            'build failed',
            '3 tests failed',
            'unused import in auth.ts',
            'plan step 2 not implemented',
        ]);
        expect(verdict?.results.filter((result) => !result.passed)).toHaveLength(3);
    });

    it('fails an enabled phase that has no result input', async () => {
        const { verdict } = await runVerification({
            ...ALL_ENABLED,
            automatedResult: { passed: true },
            reviewResult: { passed: true },
            qaResult: { passed: true },
            // directReadResult omitted — enabled but no input
        });
        expect(verdict?.verdict).toBe('REJECT');
        const directReadResult = verdict?.results.find((result) => result.phase === 'direct-read');
        expect(directReadResult?.passed).toBe(false);
        expect(directReadResult?.findings).toEqual(['direct-read phase enabled but no result provided']);
    });

    it('returns APPROVE when all phases are disabled (vacuous truth)', async () => {
        const { verdict, phaseEmits } = await runVerification({
            runAutomated: false,
            runReview: false,
            runQa: false,
            runDirectRead: false,
        });
        expect(verdict?.verdict).toBe('APPROVE');
        expect(verdict?.results).toEqual([]);
        expect(verdict?.findings).toEqual([]);
        expect(phaseEmits).toHaveLength(0);
    });

    it('writes verdict to blackboard when present', async () => {
        const blackboard = createBlackboard();
        await runVerification({ ...ALL_ENABLED, automatedResult: { passed: false, findings: ['error'] } }, blackboard);
        expect(blackboard.get('verification.passed')).toBe(false);
        expect(blackboard.get('verification.verdict')).toBe('REJECT');
        const results = blackboard.get('verification.results') as readonly VerificationPhaseResult[] | undefined;
        expect(results).toHaveLength(4);
        expect(results?.find((result) => !result.passed)?.phase).toBe('automated');
    });

    it('works without a blackboard (aggregation only)', async () => {
        const { verdict, signals } = await runVerification(
            { ...ALL_ENABLED, automatedResult: { passed: true } },
            undefined,
        );
        expect(verdict?.verdict).toBe('REJECT');
        expect(signals.some((signal) => signal.type === 'success')).toBe(true);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(false);
    });

    it('runs phases in canonical order: automated, review, qa, direct-read', async () => {
        const { phaseEmits } = await runVerification({
            ...ALL_ENABLED,
            automatedResult: { passed: true },
            reviewResult: { passed: true },
            qaResult: { passed: true },
            directReadResult: { passed: true },
        });
        const phases = phaseEmits.map((signal) => (signal.event.payload as { phase: string }).phase);
        expect(phases).toEqual(['automated', 'review', 'qa', 'direct-read']);
    });
});

describe('executeVerificationPhase (pure unit)', () => {
    it('produces a passing result from a valid input', () => {
        const result = executeVerificationPhase({
            name: 'qa',
            enabled: true,
            input: { passed: true, findings: ['ok'], artifacts: ['/tmp/qa.log'] },
        });
        expect(result).toEqual({
            phase: 'qa',
            passed: true,
            findings: ['ok'],
            artifacts: ['/tmp/qa.log'],
        });
    });

    it('produces a failing result when input is missing', () => {
        const result = executeVerificationPhase({ name: 'review', enabled: true, input: undefined });
        expect(result.passed).toBe(false);
        expect(result.findings).toEqual(['review phase enabled but no result provided']);
    });
});

describe('aggregateVerificationVerdict (pure unit)', () => {
    it('returns APPROVE when all results pass', () => {
        const results: VerificationPhaseResult[] = [
            { phase: 'automated', passed: true, findings: [] },
            { phase: 'review', passed: true, findings: [] },
        ];
        expect(aggregateVerificationVerdict(results).verdict).toBe('APPROVE');
    });

    it('flattens findings in phase order', () => {
        const results: VerificationPhaseResult[] = [
            { phase: 'automated', passed: false, findings: ['a1', 'a2'] },
            { phase: 'qa', passed: true, findings: ['q1'] },
        ];
        expect(aggregateVerificationVerdict(results).findings).toEqual(['a1', 'a2', 'q1']);
    });
});
