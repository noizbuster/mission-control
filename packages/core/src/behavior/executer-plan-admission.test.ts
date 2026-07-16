/**
 * Executer plan-admission gate (plan Task 8).
 *
 * Proves the executer rejects missing, malformed, unapproved, or incomplete plans
 * before any task delegation, and accepts only a valid approved plan.
 *   1. The admit-plan node is the entry, routes admitted -> parse-plan and
 *      rejected -> plan-rejected-terminal (terminal, no delegation path).
 *   2. The deterministic evaluatePlanAdmission helper rejects each bad shape
 *      (empty, missing section incl. no Final Verification Wave, no todos,
 *      unapproved) and accepts a valid approved scaffold plan.
 *   3. Runtime: the admit-plan llm-actor writes plan.admitted true/false from a
 *      model turn via the structured-blackboard outputKey seam.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { type AbgNodeSpec, WorkflowSpecSchema } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers';
import type { AbgNodeRunContext } from './node-registry';
import { runLlmActorNode } from './nodes/llm-actor/llm-actor-node-runner';
import {
    evaluatePlanAdmission,
    EXECUTER_APPROVED_STATUS_PATTERN,
    EXECUTER_REQUIRED_SCAFFOLD_SECTIONS,
} from './executer-plan-admission';
import {
    createExecuterWorkflowGraph,
    EXECUTER_PLAN_ADMISSION_PROMPT,
    EXECUTER_PLAN_REJECTED_PROMPT,
} from './executer-workflow-graph';
import { readFile } from 'node:fs/promises';

const WORKFLOW_FIXTURE_PATH = `${process.cwd()}/examples/abg/executer.workflow.json`;

function configString(node: AbgNodeSpec | undefined, key: string): string | undefined {
    const value = node?.config?.[key];
    return typeof value === 'string' ? value : undefined;
}

function findNode(graph: ReturnType<typeof createExecuterWorkflowGraph>, id: string): AbgNodeSpec {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) {
        throw new Error(`test setup: runner graph missing node '${id}'`);
    }
    return node;
}

const VALID_APPROVED_PLAN = [
    '# add-feature - Work Plan',
    '',
    '**Status: Approved**',
    '',
    '## TL;DR (For humans)',
    'Add the feature end to end.',
    '',
    '## Scope',
    'Must have: the feature. Must NOT have: unrelated refactors.',
    '',
    '## Verification Strategy',
    'Run the test suite.',
    '',
    '## Execution Strategy',
    'Implement then verify.',
    '',
    '## Todos',
    '- [ ] Implement the feature (refs: src/index.ts:10, acceptance: gate opens, QA: pnpm test)',
    '- [ ] Add tests',
    '',
    '## Final Verification Wave',
    '- F1 plan-compliance',
    '- F2 code-quality',
    '- F3 real manual QA',
    '- F4 scope-fidelity',
    '',
    '## Commit Strategy',
    'One commit per todo.',
    '',
    '## Success Criteria',
    'All todos checked and F-wave approves.',
].join('\n');

describe('runner admission gate: graph structure', () => {
    it('admit-plan is the entry node', () => {
        const graph = createExecuterWorkflowGraph();
        expect(graph.entryNodeId).toBe('admit-plan');
        expect(graph.nodes.map((node) => node.id)).toContain('admit-plan');
    });

    it('admit-plan routes admitted -> parse-plan and rejected -> plan-rejected-terminal', () => {
        const graph = createExecuterWorkflowGraph();
        const admitEdges = graph.edges.filter((edge) => edge.source === 'admit-plan');
        const admitted = admitEdges.find((edge) => edge.target === 'parse-plan');
        const rejected = admitEdges.find((edge) => edge.target === 'plan-rejected-terminal');
        expect(admitted?.condition).toBe('plan-admitted');
        expect(rejected?.condition).toBe('plan-rejected-admission');
    });

    it('plan-admitted requires plan.admitted === true and plan-rejected-admission requires false', () => {
        const graph = createExecuterWorkflowGraph();
        const admitted = graph.rules.find((candidate) => candidate.id === 'plan-admitted');
        const rejected = graph.rules.find((candidate) => candidate.id === 'plan-rejected-admission');
        expect(admitted?.when).toEqual({ kind: 'blackboard.value.equals', key: 'plan.admitted', value: true });
        expect(rejected?.when).toEqual({ kind: 'blackboard.value.equals', key: 'plan.admitted', value: false });
    });

    it('plan-rejected-terminal is terminal — no path to delegate-wave or parse-plan', () => {
        const graph = createExecuterWorkflowGraph();
        const outgoing = graph.edges.filter((edge) => edge.source === 'plan-rejected-terminal');
        expect(outgoing).toHaveLength(0);
        const delegationSources = graph.edges
            .filter((edge) => edge.target === 'delegate-wave')
            .map((edge) => edge.source);
        expect(delegationSources).not.toContain('plan-rejected-terminal');
    });

    it('admit-plan carries the admission prompt and a boolean plan.admitted outputKey', () => {
        const graph = createExecuterWorkflowGraph();
        const admitPlan = findNode(graph, 'admit-plan');
        expect(configString(admitPlan, 'systemPrompt')).toBe(EXECUTER_PLAN_ADMISSION_PROMPT);
        expect(configString(admitPlan, 'outputKey')).toBe('plan.admitted');
        expect(configString(admitPlan, 'outputShape')).toBe('boolean');
    });

    it('plan-rejected-terminal carries the failure prompt', () => {
        const graph = createExecuterWorkflowGraph();
        const terminal = findNode(graph, 'plan-rejected-terminal');
        expect(configString(terminal, 'systemPrompt')).toBe(EXECUTER_PLAN_REJECTED_PROMPT);
        expect(configString(terminal, 'outputKey')).toBe('plan.rejected');
    });

    it('the admission prompt names every required check', () => {
        const prompt = EXECUTER_PLAN_ADMISSION_PROMPT;
        for (const section of EXECUTER_REQUIRED_SCAFFOLD_SECTIONS) {
            expect(prompt).toContain(section);
        }
        expect(prompt).toMatch(/"- \[ \]"/);
        expect(prompt).toMatch(/Status: Approved/);
        expect(prompt).toMatch(/never reach delegate-wave/i);
    });
});

describe('runner admission gate: deterministic evaluatePlanAdmission', () => {
    it('rejects a missing/empty plan (plan_empty)', () => {
        const result = evaluatePlanAdmission('');
        expect(result.admitted).toBe(false);
        if (!result.admitted) {
            expect(result.code).toBe('plan_empty');
        }
    });

    it('rejects a whitespace-only plan (plan_empty)', () => {
        const result = evaluatePlanAdmission('   \n\n  \t  \n');
        expect(result.admitted).toBe(false);
        if (!result.admitted) {
            expect(result.code).toBe('plan_empty');
        }
    });

    it('rejects a malformed plan missing the Final Verification Wave (missing_section)', () => {
        const malformed = VALID_APPROVED_PLAN.replace('## Final Verification Wave\n', '## Notes\n');
        const result = evaluatePlanAdmission(malformed);
        expect(result.admitted).toBe(false);
        if (!result.admitted) {
            expect(result.code).toBe('missing_section');
            expect(result.reason).toMatch(/Final Verification Wave/);
        }
    });

    it('rejects a plan with scaffold but no todo checkboxes (no_todos)', () => {
        const noTodos = VALID_APPROVED_PLAN.replace(
            /## Todos\n[\s\S]*?(?=## )/,
            '## Todos\nNo checkboxes here, just prose.\n\n',
        );
        const result = evaluatePlanAdmission(noTodos);
        expect(result.admitted).toBe(false);
        if (!result.admitted) {
            expect(result.code).toBe('no_todos');
        }
    });

    it('rejects an unapproved plan (not_approved)', () => {
        const unapproved = VALID_APPROVED_PLAN.replace('**Status: Approved**', '**Status: Draft**');
        const result = evaluatePlanAdmission(unapproved);
        expect(result.admitted).toBe(false);
        if (!result.admitted) {
            expect(result.code).toBe('not_approved');
        }
    });

    it('accepts a valid approved scaffold plan', () => {
        const result = evaluatePlanAdmission(VALID_APPROVED_PLAN);
        expect(result.admitted).toBe(true);
    });

    it('EXECUTER_APPROVED_STATUS_PATTERN matches Approved, Ready, and Accepted', () => {
        expect(EXECUTER_APPROVED_STATUS_PATTERN.test('Status: Approved')).toBe(true);
        expect(EXECUTER_APPROVED_STATUS_PATTERN.test('Status: Ready')).toBe(true);
        expect(EXECUTER_APPROVED_STATUS_PATTERN.test('Status: Accepted')).toBe(true);
        expect(EXECUTER_APPROVED_STATUS_PATTERN.test('Status: Draft')).toBe(false);
    });
});

describe('runner admission gate: runtime outputKey seam', () => {
    afterEach(() => {
        createCompositeNodeTestContext();
    });

    it('admit-plan llm-actor writes plan.admitted=true when the model admits', async () => {
        const graph = createExecuterWorkflowGraph();
        const admitPlan = findNode(graph, 'admit-plan');
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'run plan X' }] as readonly ModelMessage[]);
        const context: AbgNodeRunContext = {
            graphId: 'runner-admit-true',
            now: () => '2026-07-03T00:00:00.000Z',
            sdkModel: new MockLanguageModelV3({
                provider: 'test',
                modelId: 'mock',
                doStream: async () => ({
                    stream: convertArrayToReadableStream(streamTextChunks('true')),
                }),
            }),
            blackboard,
        };
        await collectSignals(runLlmActorNode(admitPlan, context));
        expect(blackboard.get('plan.admitted')).toBe(true);
    });

    it('admit-plan llm-actor writes plan.admitted=false when the model rejects', async () => {
        const graph = createExecuterWorkflowGraph();
        const admitPlan = findNode(graph, 'admit-plan');
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'run plan Y' }] as readonly ModelMessage[]);
        const context: AbgNodeRunContext = {
            graphId: 'runner-admit-false',
            now: () => '2026-07-03T00:00:00.000Z',
            sdkModel: new MockLanguageModelV3({
                provider: 'test',
                modelId: 'mock',
                doStream: async () => ({
                    stream: convertArrayToReadableStream(streamTextChunks('false')),
                }),
            }),
            blackboard,
        };
        await collectSignals(runLlmActorNode(admitPlan, context));
        expect(blackboard.get('plan.admitted')).toBe(false);
    });
});

describe('runner admission gate: fixture parity', () => {
    it('the fixture graph matches createExecuterWorkflowGraph (admit-plan entry)', async () => {
        const spec = WorkflowSpecSchema.parse(JSON.parse(await readFile(WORKFLOW_FIXTURE_PATH, 'utf8')));
        expect(spec.graph).toEqual(createExecuterWorkflowGraph());
        expect(spec.graph.entryNodeId).toBe('admit-plan');
    });
});

function streamTextChunks(text: string): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
        },
    ];
}
