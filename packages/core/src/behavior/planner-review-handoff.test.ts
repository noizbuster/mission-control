/**
 * Planner review + runner handoff gates (plan Task 8).
 *
 * Proves the Metis/Momus-style review semantics on the planner review-plan node
 * and the runner handoff contract:
 *   1. review-plan documents gap analysis (references, QA, acceptance, scaffold)
 *      and is approve-biased; high-accuracy dual review is opt-in, not default.
 *   2. review-plan runs the deterministic critic in draft-heuristic mode (no
 *      evaluateKey) so approve-biased executability checks gate the draft.
 *   3. Routing: reject loops back to draft-plan (revision); approve reaches the
 *      approval gate, then write-plan, then the present/handoff node.
 *   4. Runtime: an evidence-citing draft passes (critic.passed=true); an empty
 *      or non-answer draft is rejected (critic.passed=false) and would loop.
 *   5. Runner refuses absent/malformed plans at the entry admission gate.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { type AbgNodeSpec, WorkflowSpecSchema } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers';
import type { AbgNodeRunContext } from './node-registry';
import { runCriticNode } from './nodes/critic-node';
import { createPlannerWorkflowGraph, PLANNER_REVIEW_GAP_ANALYSIS_PROMPT } from './planner-workflow-graph';
import { createExecuterWorkflowGraph } from './executer-workflow-graph';
import { readFile } from 'node:fs/promises';

const WORKFLOW_FIXTURE_PATH = `${process.cwd()}/examples/abg/planner.workflow.json`;

function configString(node: AbgNodeSpec | undefined, key: string): string | undefined {
    const value = node?.config?.[key];
    return typeof value === 'string' ? value : undefined;
}

function findNode(graph: ReturnType<typeof createPlannerWorkflowGraph>, id: string): AbgNodeSpec {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) {
        throw new Error(`test setup: planner graph missing node '${id}'`);
    }
    return node;
}

function criticContext(draftText: string) {
    const blackboard = createBlackboard();
    blackboard.setMessages([
        { role: 'user', content: 'draft the plan' },
        { role: 'assistant', content: draftText },
    ]);
    return { graphId: 'planner-review', now: () => '2026-07-03T00:00:00.000Z', blackboard };
}

describe('planner review-plan: Metis/Momus gap-analysis contract', () => {
    it('exposes the gap-analysis prompt as an exported constant', () => {
        expect(PLANNER_REVIEW_GAP_ANALYSIS_PROMPT).toMatch(/GAP ANALYSIS/i);
        expect(PLANNER_REVIEW_GAP_ANALYSIS_PROMPT).toMatch(/APPROVE-BIAS|approve-bias/i);
    });

    it('review-plan carries the gap-analysis systemPrompt', () => {
        const graph = createPlannerWorkflowGraph();
        const prompt = configString(findNode(graph, 'review-plan'), 'systemPrompt') ?? '';
        expect(prompt).toBe(PLANNER_REVIEW_GAP_ANALYSIS_PROMPT);
    });

    it('the prompt documents gap analysis for references, QA, acceptance, and scaffold headers', () => {
        const prompt = PLANNER_REVIEW_GAP_ANALYSIS_PROMPT;
        expect(prompt).toMatch(/MISSING REFERENCES/i);
        expect(prompt).toMatch(/MISSING QA SCENARIOS/i);
        expect(prompt).toMatch(/MISSING ACCEPTANCE CRITERIA/i);
        expect(prompt).toMatch(/MISSING SCAFFOLD HEADERS/i);
    });

    it('the prompt is approve-biased (approve unless a concrete blocker)', () => {
        const prompt = PLANNER_REVIEW_GAP_ANALYSIS_PROMPT;
        expect(prompt).toMatch(/APPROVE-BIAS/i);
        expect(prompt).toMatch(/80% clear is good enough/i);
        expect(prompt).toMatch(/do not reject for stylistic preferences/i);
    });

    it('the prompt documents high-accuracy dual review as opt-in, not default', () => {
        const prompt = PLANNER_REVIEW_GAP_ANALYSIS_PROMPT;
        expect(prompt).toMatch(/HIGH-ACCURACY DUAL REVIEW/i);
        expect(prompt).toMatch(/NOT run here by default/i);
        expect(prompt).toMatch(/opt-in/i);
        expect(prompt).toMatch(/do not block the handoff/i);
    });
});

describe('planner review-plan: approve-biased executability floor (draft-heuristic critic)', () => {
    it('review-plan runs the critic in draft-heuristic mode (no evaluateKey)', () => {
        const graph = createPlannerWorkflowGraph();
        const reviewPlan = findNode(graph, 'review-plan');
        expect(reviewPlan.implementation).toBe('critic');
        expect(configString(reviewPlan, 'evaluateKey')).toBeUndefined();
        expect(configString(reviewPlan, 'outputKey')).toBe('plan.approved');
    });

    it('approves an evidence-citing draft (critic.passed=true -> approval gate path)', async () => {
        const graph = createPlannerWorkflowGraph();
        const reviewPlan = findNode(graph, 'review-plan');
        const context = criticContext(
            'Plan drafted. Refs: packages/core/src/agent-runtime.ts:42 adds the guard. ' +
                'QA: run `pnpm test` expecting exit 0. Acceptance: gate opens on plan.ready=true.',
        );
        await collectSignals(runCriticNode(reviewPlan, context));
        expect(context.blackboard?.get('critic.passed')).toBe(true);
    });

    it('rejects a non-answer draft (critic.passed=false -> loops to draft-plan)', async () => {
        const graph = createPlannerWorkflowGraph();
        const reviewPlan = findNode(graph, 'review-plan');
        const context = criticContext("I don't know how to plan this yet.");
        await collectSignals(runCriticNode(reviewPlan, context));
        expect(context.blackboard?.get('critic.passed')).toBe(false);
    });

    it('rejects an evidence-free draft (critic.passed=false -> loops to draft-plan)', async () => {
        const graph = createPlannerWorkflowGraph();
        const reviewPlan = findNode(graph, 'review-plan');
        const context = criticContext('It should work after the change.');
        await collectSignals(runCriticNode(reviewPlan, context));
        expect(context.blackboard?.get('critic.passed')).toBe(false);
    });
});

describe('planner review-plan: routing loops to revision and reaches handoff', () => {
    it('reject routes back to draft-plan for revision (plan-rejected condition)', () => {
        const graph = createPlannerWorkflowGraph();
        const rejectEdge = graph.edges.find((edge) => edge.source === 'review-plan' && edge.target === 'draft-plan');
        expect(rejectEdge?.condition).toBe('plan-rejected');
        const rule = graph.rules.find((candidate) => candidate.id === 'plan-rejected');
        expect(rule?.when).toEqual({ kind: 'blackboard.value.equals', key: 'critic.passed', value: false });
    });

    it('approve routes forward to the approval gate (plan-approved condition)', () => {
        const graph = createPlannerWorkflowGraph();
        const approveEdge = graph.edges.find(
            (edge) => edge.source === 'review-plan' && edge.target === 'approval-gate',
        );
        expect(approveEdge?.condition).toBe('plan-approved');
        const rule = graph.rules.find((candidate) => candidate.id === 'plan-approved');
        expect(rule?.when).toEqual({ kind: 'blackboard.value.equals', key: 'critic.passed', value: true });
    });

    it('a valid plan reaches the handoff (present) only through write-plan after approval', () => {
        const graph = createPlannerWorkflowGraph();
        const writePlanToPresent = graph.edges.find(
            (edge) => edge.source === 'write-plan' && edge.target === 'present',
        );
        expect(writePlanToPresent?.condition).toBe('plan-written');
        const incomingToPresent = graph.edges.filter((edge) => edge.target === 'present' && edge.source !== 'present');
        expect(incomingToPresent.length).toBe(1);
        expect(incomingToPresent[0]?.source).toBe('write-plan');
    });

    it('write-plan emits the Status: Approved handoff marker for the executer admission gate', () => {
        const graph = createPlannerWorkflowGraph();
        const prompt = configString(findNode(graph, 'write-plan'), 'systemPrompt') ?? '';
        expect(prompt).toMatch(/Status: Approved/i);
        expect(prompt).toMatch(/executer admission gate/i);
    });
});

describe('planner review-plan: fixture parity', () => {
    it('the fixture review-plan matches the factory (no evaluateKey, gap-analysis prompt)', async () => {
        const spec = WorkflowSpecSchema.parse(JSON.parse(await readFile(WORKFLOW_FIXTURE_PATH, 'utf8')));
        const graph = spec.graph;
        const reviewPlan = graph.nodes.find((node) => node.id === 'review-plan');
        expect(configString(reviewPlan, 'evaluateKey')).toBeUndefined();
        expect(configString(reviewPlan, 'systemPrompt')).toBe(PLANNER_REVIEW_GAP_ANALYSIS_PROMPT);
    });
});

describe('runner handoff: refuses absent or malformed plans at the entry gate', () => {
    it('the runner entry is the admit-plan gate (not parse-plan)', () => {
        const graph = createExecuterWorkflowGraph();
        expect(graph.entryNodeId).toBe('admit-plan');
    });

    it('a rejected plan routes to plan-rejected-terminal and never reaches delegate-wave', () => {
        const graph = createExecuterWorkflowGraph();
        const rejectEdge = graph.edges.find(
            (edge) => edge.source === 'admit-plan' && edge.target === 'plan-rejected-terminal',
        );
        expect(rejectEdge?.condition).toBe('plan-rejected-admission');
        // No outgoing edge from the terminal node — it is terminal.
        const outgoing = graph.edges.filter((edge) => edge.source === 'plan-rejected-terminal');
        expect(outgoing).toHaveLength(0);
        // No edge connects the terminal node to the delegation path.
        const toDelegation = graph.edges.filter((edge) => edge.target === 'delegate-wave');
        for (const edge of toDelegation) {
            expect(edge.source).not.toBe('plan-rejected-terminal');
        }
    });
});

describe('planner review-plan: runtime outputKey seam cleanup', () => {
    // Resets the shared composite-node test context after the suite. Mirrors the
    // planner-workflow-parity.test.ts afterEach to avoid cross-suite state drift.
    afterEach(() => {
        createCompositeNodeTestContext();
    });

    it('runLlmActorNode is importable for cross-suite parity (smoke)', async () => {
        const { runLlmActorNode } = await import('./nodes/llm-actor/llm-actor-node-runner');
        const graph = createPlannerWorkflowGraph();
        const approvalGate = findNode(graph, 'approval-gate');
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'approve' }] as readonly ModelMessage[]);
        const context: AbgNodeRunContext = {
            graphId: 'planner-review-smoke',
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
        await collectSignals(runLlmActorNode(approvalGate, context));
        expect(blackboard.get('plan.ready')).toBe(true);
        expect(typeof runLlmActorNode).toBe('function');
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
