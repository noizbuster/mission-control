// allow: SIZE_OK -- HEAD 173 -> current 278 pure LOC; one cohesive executer final-wave verdict + fix-loop routing + progress-contract enum/shape matrix and 3-strike regression guard.
import type { AbgNodeSpec } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    aggregateFinalVerdict,
    createExecuterWorkflowGraph,
    EXECUTER_FINAL_STRIKE_BUDGET,
    routeFixLoop,
} from './executer-workflow-graph';

function nodeById(id: string): AbgNodeSpec | undefined {
    return createExecuterWorkflowGraph().nodes.find((node) => node.id === id);
}

function configString(node: AbgNodeSpec | undefined, key: string): string | undefined {
    const value = node?.config?.[key];
    return typeof value === 'string' ? value : undefined;
}

function configNumber(node: AbgNodeSpec | undefined, key: string): number | undefined {
    const value = node?.config?.[key];
    return typeof value === 'number' ? value : undefined;
}

function configArray(node: AbgNodeSpec | undefined, key: string): ReadonlyArray<unknown> | undefined {
    const value = node?.config?.[key];
    return Array.isArray(value) ? value : undefined;
}

function configValue(node: AbgNodeSpec | undefined, key: string): unknown {
    return node?.config?.[key];
}

describe('runner final-wave verdict aggregation — aggregateFinalVerdict (all-approve gate)', () => {
    it('returns APPROVE when all four critics approve', () => {
        expect(aggregateFinalVerdict(['APPROVE', 'APPROVE', 'APPROVE', 'APPROVE'])).toBe('APPROVE');
    });

    it('returns REJECT when exactly one critic rejects (F1-F4 any order)', () => {
        // The required stopping condition: one REJECT routes to fix-loop, never complete.
        expect(aggregateFinalVerdict(['REJECT', 'APPROVE', 'APPROVE', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict(['APPROVE', 'REJECT', 'APPROVE', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict(['APPROVE', 'APPROVE', 'REJECT', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict(['APPROVE', 'APPROVE', 'APPROVE', 'REJECT'])).toBe('REJECT');
    });

    it('returns REJECT when multiple critics reject', () => {
        expect(aggregateFinalVerdict(['REJECT', 'REJECT', 'APPROVE', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict(['REJECT', 'REJECT', 'REJECT', 'REJECT'])).toBe('REJECT');
    });

    it('fails closed (REJECT) when any critic output is missing or non-APPROVE', () => {
        // A missing critic must not be treated as tacit approval — all four must explicitly APPROVE.
        expect(aggregateFinalVerdict(['APPROVE', undefined, 'APPROVE', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict(['APPROVE', '', 'APPROVE', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict(['APPROVE', 'approve', 'APPROVE', 'APPROVE'])).toBe('REJECT');
    });

    it('fails closed (REJECT) on an empty verdict set', () => {
        expect(aggregateFinalVerdict([])).toBe('REJECT');
    });
});

describe('runner final-wave verdict aggregation — graph wiring', () => {
    const graph = createExecuterWorkflowGraph();
    const finalWave = nodeById('final-verification-wave');

    it('declares a string verdictStrategy (all-approve) on the parallel node', () => {
        expect(configString(finalWave, 'verdictStrategy')).toBe('all-approve');
    });

    it('writes the aggregated string verdict to final.verdict, not a boolean completionKey', () => {
        expect(configString(finalWave, 'verdictKey')).toBe('final.verdict');
        expect(configString(finalWave, 'completionKey')).not.toBe('final.verdict');
    });

    it('reads all four critic outputs as its verdict sources', () => {
        expect(configArray(finalWave, 'verdictSources')).toEqual(['final.f1', 'final.f2', 'final.f3', 'final.f4']);
    });

    it('routes final-verification-wave to complete only on APPROVE and fix-loop on REJECT', () => {
        const targets = graph.edges
            .filter((edge) => edge.source === 'final-verification-wave')
            .map((edge) => ({ target: edge.target, condition: edge.condition }));

        expect(targets).toContainEqual({ target: 'complete', condition: 'final-approved' });
        expect(targets).toContainEqual({ target: 'fix-loop', condition: 'final-rejected' });
    });

    it('routes on the string final.verdict (APPROVE / REJECT), not a boolean', () => {
        const finalApproved = graph.rules.find((rule) => rule.id === 'final-approved');
        const finalRejected = graph.rules.find((rule) => rule.id === 'final-rejected');

        expect(finalApproved?.when).toMatchObject({ key: 'final.verdict', value: 'APPROVE' });
        expect(finalRejected?.when).toMatchObject({ key: 'final.verdict', value: 'REJECT' });
    });

    it('does NOT declare a path that completes the executer while any critic could still reject', () => {
        // The complete node is reachable ONLY via final-approved (all four APPROVE). There is
        // no edge from fix-loop or any other node directly into complete.
        const intoComplete = graph.edges.filter((edge) => edge.target === 'complete');
        expect(intoComplete).toHaveLength(1);
        expect(intoComplete[0]?.source).toBe('final-verification-wave');
        expect(intoComplete[0]?.condition).toBe('final-approved');
    });
});

describe('runner 3-strike fix-loop — routeFixLoop ceiling', () => {
    it('retries while the strike count is strictly below the budget', () => {
        expect(routeFixLoop(0, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('retry');
        expect(routeFixLoop(1, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('retry');
        expect(routeFixLoop(2, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('retry');
    });

    it('blocks exactly when the strike count reaches the budget (3rd strike)', () => {
        // Three repeated failures: strikes 1 and 2 retry, strike 3 blocks.
        expect(routeFixLoop(EXECUTER_FINAL_STRIKE_BUDGET, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('blocked');
        expect(routeFixLoop(4, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('blocked');
    });
});

describe('runner 3-strike fix-loop — graph wiring', () => {
    const graph = createExecuterWorkflowGraph();
    const fixLoop = nodeById('fix-loop');
    const blockedEscalation = nodeById('blocked-escalation');

    it('declares a numeric strike budget (3) on the fix-loop node', () => {
        expect(configNumber(fixLoop, 'strikeBudget')).toBe(EXECUTER_FINAL_STRIKE_BUDGET);
        expect(configNumber(fixLoop, 'maxStrikes')).toBe(EXECUTER_FINAL_STRIKE_BUDGET);
    });

    it('writes the route decision to fix.route (retry | blocked), not the old fix.retry boolean', () => {
        expect(configString(fixLoop, 'outputKey')).toBe('fix.route');
        expect(configString(fixLoop, 'strikeKey')).toBe('fix.strikes');
    });

    it('routes fix-loop to next-wave on fix-retry and to blocked-escalation on fix-blocked', () => {
        const edges = graph.edges
            .filter((edge) => edge.source === 'fix-loop')
            .map((edge) => ({ target: edge.target, condition: edge.condition }));

        expect(edges).toContainEqual({ target: 'next-wave', condition: 'fix-retry' });
        expect(edges).toContainEqual({ target: 'blocked-escalation', condition: 'fix-blocked' });
    });

    it('rule predicates route on the fix.route string values', () => {
        const fixRetry = graph.rules.find((rule) => rule.id === 'fix-retry');
        const fixBlocked = graph.rules.find((rule) => rule.id === 'fix-blocked');

        expect(fixRetry?.when).toMatchObject({ key: 'fix.route', value: 'retry' });
        expect(fixBlocked?.when).toMatchObject({ key: 'fix.route', value: 'blocked' });
    });

    it('ships a blocked-escalation terminal node that records state and blocks for the user', () => {
        expect(blockedEscalation?.kind).toBe('llm');
        expect(configString(blockedEscalation, 'outputKey')).toBe('fix.blocked');
        const prompt = configString(blockedEscalation, 'systemPrompt') ?? '';
        expect(prompt).toMatch(/evidence/i);
        expect(prompt).toMatch(/user intervention|human intervention|block/i);
    });

    it('blocked-escalation has no outgoing edge back into the delegate/fix-loop (no silent restart)', () => {
        const outgoing = graph.edges.filter((edge) => edge.source === 'blocked-escalation');
        expect(outgoing).toHaveLength(0);
    });
});

describe('runner retry session reuse — persisted child session id lineage', () => {
    const fixLoop = nodeById('fix-loop');

    it('fix-loop config declares the child session lineage and retry-state keys', () => {
        expect(configString(fixLoop, 'lineageKey')).toBe('run.childSessionIds');
        expect(configString(fixLoop, 'retryStateKey')).toBe('run.taskRetryState');
    });

    it('fix-loop prompt instructs reusing the persisted child session id on retry', () => {
        const prompt = configString(fixLoop, 'systemPrompt') ?? '';
        expect(prompt).toMatch(/child session id|childSessionIds|taskRetryState/i);
        expect(prompt).toMatch(/reuse/i);
        expect(prompt).toMatch(/resumes with full prior context|full prior context/i);
    });

    it('blocked-escalation prompt records the last child session ids attempted', () => {
        const prompt = configString(nodeById('blocked-escalation'), 'systemPrompt') ?? '';
        expect(prompt).toMatch(/child session ids attempted|last child session/i);
    });
});

describe('runner final-wave — graph loop bound still protects against bugs', () => {
    const graph = createExecuterWorkflowGraph();

    it('declares a finite maxNodeRuns default (independent backstop)', () => {
        expect(graph.defaults?.maxNodeRuns).toBe(64);
    });

    it('the fix-loop -> next-wave retry edge plus blocked-escalation keeps the loop finite', () => {
        const fixLoopEdges = graph.edges.filter((edge) => edge.source === 'fix-loop' && edge.source !== edge.target);
        expect(fixLoopEdges).toHaveLength(2);

        const conditions = new Set(fixLoopEdges.map((edge) => edge.condition));
        expect(conditions).toEqual(new Set(['fix-retry', 'fix-blocked']));
    });
});

describe('runner final-wave — end-to-end decision matrix over the pure contracts', () => {
    // Combines the verdict aggregation and the strike ceiling into the four
    // stopping-condition scenarios the task names, driven through the pure
    // contracts that the graph wiring references.
    it('scenario A: four APPROVE -> final.verdict APPROVE -> complete (no fix-loop)', () => {
        const verdict = aggregateFinalVerdict(['APPROVE', 'APPROVE', 'APPROVE', 'APPROVE']);
        expect(verdict).toBe('APPROVE');
    });

    it('scenario B: one REJECT -> final.verdict REJECT -> fix-loop (strike 1, retry)', () => {
        const verdict = aggregateFinalVerdict(['APPROVE', 'REJECT', 'APPROVE', 'APPROVE']);
        expect(verdict).toBe('REJECT');
        expect(routeFixLoop(1, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('retry');
    });

    it('scenario C: second consecutive REJECT -> fix-loop (strike 2, still retry)', () => {
        expect(routeFixLoop(2, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('retry');
    });

    it('scenario D: third consecutive REJECT -> fix.route blocked -> blocked-escalation', () => {
        expect(routeFixLoop(3, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('blocked');
    });
});

// Progress-contract routing-key matrix (plan Task 7). Mirrors FIXER_EQUALS_ROUTED_LLM_GATES:
// every EQUALS-routed llm output key declares a fail-closed shape/enum so a poisoned value cannot
// silently complete the graph (applyEnumConstraint / parseStructuredOutput reject out-of-set values).
//
// verify.complete and checkbox.updated are excluded BY DESIGN (do NOT re-add outputShape 'boolean'):
//   - verify.complete: per-task-verify is `implementation: 'critic'`; runVerificationResultCritic
//     writes the critic's APPROVE/REJECT string verdict there (not a boolean) and never crosses
//     parseStructuredOutput. A boolean shape would be factually wrong and inert. key.exists-routed.
//   - checkbox.updated: key.exists-routed (checkbox-updated), an existence gate not a value gate;
//     per the todo-plan (plan.todos) convention in the fixer matrix, existence keys stay shape-free.
//   - delegate.complete / final.complete: written by parallel nodes (completionKey), not llm nodes.
const EXECUTER_EQUALS_ROUTED_LLM_GATES = [
    { nodeId: 'admit-plan', outputKey: 'plan.admitted', kind: 'boolean' as const },
    { nodeId: 'next-wave', outputKey: 'wave.pending', kind: 'boolean' as const },
    {
        nodeId: 'fix-loop',
        outputKey: 'fix.route',
        kind: 'enum' as const,
        outputEnum: ['retry', 'blocked'],
    },
] as const;

describe('executer progress-contract routing key matrix', () => {
    it.each(EXECUTER_EQUALS_ROUTED_LLM_GATES)(
        '$nodeId declares fail-closed shape/enum for equals-routed $outputKey',
        (gate) => {
            const node = nodeById(gate.nodeId);
            expect(configString(node, 'outputKey')).toBe(gate.outputKey);
            if (gate.kind === 'boolean') {
                expect(configString(node, 'outputShape')).toBe('boolean');
            } else {
                expect(configValue(node, 'outputEnum')).toEqual([...gate.outputEnum]);
            }
        },
    );

    it('each enum/boolean gate backs a blackboard.value.equals rule (no bare key.exists routing)', () => {
        const graph = createExecuterWorkflowGraph();
        for (const gate of EXECUTER_EQUALS_ROUTED_LLM_GATES) {
            const matches = graph.rules.filter(
                (rule) =>
                    rule.when.kind === 'blackboard.value.equals' &&
                    rule.when.key === gate.outputKey,
            );
            expect(matches.length, `${gate.outputKey} must be equals-routed`).toBeGreaterThan(0);
        }
    });
});

describe('executer final.verdict stays aggregateFinalVerdict (not an llm outputEnum)', () => {
    const graph = createExecuterWorkflowGraph();

    it('no llm node owns final.verdict as an outputKey (it is the parallel node verdictKey)', () => {
        const verdictWriter = graph.nodes.find((node) => configString(node, 'outputKey') === 'final.verdict');
        expect(verdictWriter, 'no llm node may own final.verdict as an outputKey').toBeUndefined();
    });

    it('the F1-F4 critics emit free-text APPROVE/REJECT without an outputEnum lock (aggregated, not enum-gated)', () => {
        for (const criticId of ['f1', 'f2', 'f3', 'f4']) {
            const critic = nodeById(criticId);
            expect(critic?.kind).toBe('llm');
            expect(configString(critic, 'outputKey')).toBe(`final.${criticId}`);
            expect(configValue(critic, 'outputEnum'), `${criticId} must not enum-lock its verdict`).toBeUndefined();
        }
    });

    it('final.verdict is written by the parallel node verdictStrategy (all-approve), not an llm outputKey', () => {
        const finalWave = nodeById('final-verification-wave');
        expect(finalWave?.kind).toBe('parallel');
        expect(configString(finalWave, 'verdictKey')).toBe('final.verdict');
        expect(configString(finalWave, 'verdictStrategy')).toBe('all-approve');
    });

    it('aggregateFinalVerdict is the APPROVE|REJECT authority and fails closed', () => {
        expect(aggregateFinalVerdict(['APPROVE', 'APPROVE', 'APPROVE', 'APPROVE'])).toBe('APPROVE');
        expect(aggregateFinalVerdict(['APPROVE', 'REJECT', 'APPROVE', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict(['APPROVE', undefined, 'APPROVE', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict([])).toBe('REJECT');
    });

    it('fix-loop is the only llm enum gate and locks fix.route to retry|blocked (not APPROVE|REJECT)', () => {
        const fixLoop = nodeById('fix-loop');
        expect(configValue(fixLoop, 'outputEnum')).toEqual(['retry', 'blocked']);
        const enumGatedNodes = graph.nodes.filter(
            (node) => node.kind === 'llm' && configValue(node, 'outputEnum') !== undefined,
        );
        expect(enumGatedNodes.map((node) => node.id)).toEqual(['fix-loop']);
    });

    it('per-task-verify writes a critic verdict string, not a boolean (verify.complete must stay shape-free)', () => {
        const perTaskVerify = nodeById('per-task-verify');
        expect(perTaskVerify?.implementation).toBe('critic');
        expect(configString(perTaskVerify, 'outputKey')).toBe('verify.complete');
        expect(configValue(perTaskVerify, 'outputShape'), 'critic verdict is APPROVE/REJECT, not boolean').toBeUndefined();
        expect(configValue(perTaskVerify, 'outputEnum')).toBeUndefined();
    });
});

describe('executer 3-strike fix-loop / blocked-escalation regression guard', () => {
    const graph = createExecuterWorkflowGraph();

    it('strike budget stays 3 on fix-loop and blocked-escalation', () => {
        expect(EXECUTER_FINAL_STRIKE_BUDGET).toBe(3);
        expect(configNumber(nodeById('fix-loop'), 'strikeBudget')).toBe(3);
        expect(configNumber(nodeById('fix-loop'), 'maxStrikes')).toBe(3);
        expect(configNumber(nodeById('blocked-escalation'), 'strikeBudget')).toBe(3);
    });

    it('routeFixLoop keeps strikes 1 and 2 retrying and strike 3 blocking', () => {
        expect(routeFixLoop(1, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('retry');
        expect(routeFixLoop(2, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('retry');
        expect(routeFixLoop(3, EXECUTER_FINAL_STRIKE_BUDGET)).toBe('blocked');
    });

    it('fix-loop still routes retry -> next-wave and blocked -> blocked-escalation', () => {
        const edges = graph.edges
            .filter((edge) => edge.source === 'fix-loop' && edge.source !== edge.target)
            .map((edge) => ({ target: edge.target, condition: edge.condition }));

        expect(edges).toContainEqual({ target: 'next-wave', condition: 'fix-retry' });
        expect(edges).toContainEqual({ target: 'blocked-escalation', condition: 'fix-blocked' });
    });

    it('blocked-escalation remains terminal (no outgoing edges back into the loop)', () => {
        const outgoing = graph.edges.filter((edge) => edge.source === 'blocked-escalation');
        expect(outgoing).toHaveLength(0);
    });
});
