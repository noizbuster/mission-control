/**
 * Planner workflow Prometheus-mechanics parity suite (plan Task 7).
 *
 * Proves the behaviors ported from the reference ulw-plan / Prometheus planner:
 *   1. Sticky plan mode — the planner produces a PLAN, never product code.
 *   2. Planner-readonly denies product writes on the EXECUTED (materialized)
 *      graph and allows only .omo/plans/**, .omo/specs/**, .omo/drafts/**.
 *   3. Draft state — draft-plan targets .omo/drafts/<slug>.md and carries the
 *      write capability, BEFORE the final plan handoff.
 *   4. Approval gate — write-plan is reachable ONLY via the plan-ready rule
 *      (plan.ready === true); approval-gate self-loops while awaiting.
 *   5. Scaffold-compatible output — write-plan emits the scaffold headers and
 *      the Todos carry `- [ ]` checkbox fields.
 *   6. Planner-readonly child consultations — explore/research prompts warn
 *      that delegated children inherit the planner-readonly boundary.
 *   7. Runtime — the llm-actor outputKey seam writes plan.drafted and
 *      plan.ready to the blackboard from a real model turn.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { type AbgNodeSpec, WorkflowSpecSchema } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard.js';
import { evaluateRules } from '../permissions/rule-evaluator.js';
import { materializeWorkflow } from '../workflows/materialize-workflow.js';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers.js';
import { applyMode } from './modes/mode-application.js';
import type { AbgNodeRunContext } from './node-registry.js';
import { runLlmActorNode } from './nodes/llm-actor/llm-actor-node-runner.js';
import {
    createPlannerWorkflowGraph,
    PLANNER_READONLY_CHILD_CONTEXT,
    PLANNER_READONLY_MODE,
    PLANNER_READONLY_POLICIES,
    PLANNER_SCAFFOLD_HEADERS,
} from './planner-workflow-graph.js';
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

async function loadPlannerSpec(): Promise<unknown> {
    const contents = await readFile(WORKFLOW_FIXTURE_PATH, 'utf8');
    return JSON.parse(contents);
}

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

function runContextWithMessages(messages: readonly ModelMessage[]): AbgNodeRunContext {
    const blackboard = createBlackboard();
    blackboard.appendMessages([...messages]);
    return {
        graphId: 'planner-parity',
        now: () => '2026-07-03T00:00:00.000Z',
        sdkModel: new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => ({ stream: convertArrayToReadableStream(streamTextChunks('true')) }),
        }),
        blackboard,
    };
}

describe('planner workflow parity: sticky plan mode', () => {
    it('the planner-readonly overlay declares sticky plan mode (never implements)', () => {
        const overlay = PLANNER_READONLY_MODE.systemPromptOverlay;
        expect(overlay).toMatch(/STICKY|sticky plan mode/i);
        expect(overlay).toMatch(/NEVER implement/i);
        expect(overlay).toMatch(/#runner|explicit start/i);
    });

    it('intake prompt treats do/fix/build as plan requests', () => {
        const graph = createPlannerWorkflowGraph();
        const intake = configString(findNode(graph, 'intake'), 'systemPrompt') ?? '';
        expect(intake).toMatch(/PLANNER/i);
        expect(intake).toMatch(/do.*fix.*build|"do"|plan the work/i);
        expect(intake).toMatch(/not implement/i);
    });

    it('no planner node declares an exec or bash capability that could implement', () => {
        const graph = createPlannerWorkflowGraph();
        for (const node of graph.nodes) {
            const caps = node.capabilities ?? [];
            expect(caps).not.toContain('exec');
            expect(caps).not.toContain('bash');
        }
    });
});

describe('planner workflow parity: planner-readonly on the executed graph', () => {
    it('denies product-source writes on the materialized graph', async () => {
        const spec = WorkflowSpecSchema.parse(await loadPlannerSpec());
        const executed = materializeWorkflow(spec);
        const writeDeny = executed.policies.find(
            (policy) => policy.capability === 'write' && policy.decision === 'deny',
        );
        expect(writeDeny).toBeDefined();
    });

    it('planner-readonly policies deny src/** and allow the three .omo artifact roots', () => {
        const ruleset = [{ rules: [...PLANNER_READONLY_POLICIES] }];
        expect(evaluateRules('write', 'src/index.ts', ruleset).effect).toBe('deny');
        expect(evaluateRules('write', 'packages/core/src/index.ts', ruleset).effect).toBe('deny');
        expect(evaluateRules('write', '.omo/plans/plan.md', ruleset).effect).toBe('allow');
        expect(evaluateRules('write', '.omo/specs/spec.md', ruleset).effect).toBe('allow');
        expect(evaluateRules('write', '.omo/drafts/plan.md', ruleset).effect).toBe('allow');
    });

    it('applyMode converts every planner-readonly policy into graph-level policy entries', () => {
        const graph = createPlannerWorkflowGraph();
        const result = applyMode(graph, PLANNER_READONLY_MODE);
        const writePolicies = result.policies.filter((policy) => policy.capability === 'write');
        expect(writePolicies.length).toBeGreaterThanOrEqual(PLANNER_READONLY_POLICIES.length);
    });

    it('the fixture declares the planner-readonly mode matching the factory policies', async () => {
        const spec = WorkflowSpecSchema.parse(await loadPlannerSpec());
        const mode = (spec.modes ?? []).find((entry) => entry.id === 'planner-readonly');
        expect(mode).toBeDefined();
        expect(mode?.policies).toEqual([...PLANNER_READONLY_POLICIES]);
    });
});

describe('planner workflow parity: draft state before final plan', () => {
    it('draft-plan writes to .omo/drafts and sets plan.drafted', () => {
        const graph = createPlannerWorkflowGraph();
        const draftPlan = findNode(graph, 'draft-plan');
        expect(configString(draftPlan, 'outputKey')).toBe('plan.drafted');
        const prompt = configString(draftPlan, 'systemPrompt') ?? '';
        expect(prompt).toMatch(/\.omo\/drafts/);
        expect(prompt).toMatch(/DRAFT/i);
        expect(prompt).toMatch(/do not.*\.omo\/plans/i);
    });

    it('draft-plan carries the write capability needed to author the draft', () => {
        const graph = createPlannerWorkflowGraph();
        const draftPlan = findNode(graph, 'draft-plan');
        expect(draftPlan.capabilities).toContain('write');
    });

    it('the draft precedes review-plan which precedes the approval gate', () => {
        const graph = createPlannerWorkflowGraph();
        const draftToReview = graph.edges.find(
            (edge) => edge.source === 'draft-plan' && edge.target === 'review-plan',
        );
        const reviewToGate = graph.edges.find(
            (edge) => edge.source === 'review-plan' && edge.target === 'approval-gate',
        );
        expect(draftToReview?.condition).toBe('plan-drafted');
        expect(reviewToGate?.condition).toBe('plan-approved');
    });
});

describe('planner workflow parity: approval gate blocks the final plan write', () => {
    it('write-plan is reachable ONLY via the plan-ready rule (excluding self-loops)', () => {
        const graph = createPlannerWorkflowGraph();
        const incomingToWritePlan = graph.edges.filter(
            (edge) => edge.target === 'write-plan' && edge.source !== 'write-plan',
        );
        expect(incomingToWritePlan.length).toBe(1);
        expect(incomingToWritePlan[0]?.source).toBe('approval-gate');
        expect(incomingToWritePlan[0]?.condition).toBe('plan-ready');
    });

    it('the plan-ready rule requires plan.ready === true', () => {
        const graph = createPlannerWorkflowGraph();
        const rule = graph.rules.find((candidate) => candidate.id === 'plan-ready');
        expect(rule?.when).toEqual({ kind: 'blackboard.value.equals', key: 'plan.ready', value: true });
    });

    it('approval-gate self-loops on plan-awaiting-approval (the wait state)', () => {
        const graph = createPlannerWorkflowGraph();
        const selfLoop = graph.edges.find(
            (edge) => edge.source === 'approval-gate' && edge.target === 'approval-gate',
        );
        expect(selfLoop?.condition).toBe('plan-awaiting-approval');
        const rule = graph.rules.find((candidate) => candidate.id === 'plan-awaiting-approval');
        expect(rule?.when).toEqual({ kind: 'blackboard.value.equals', key: 'plan.ready', value: false });
    });

    it('approval-gate prompt forbids setting plan.ready until explicit approval', () => {
        const graph = createPlannerWorkflowGraph();
        const gate = findNode(graph, 'approval-gate');
        const prompt = configString(gate, 'systemPrompt') ?? '';
        expect(prompt).toMatch(/WAIT/i);
        expect(prompt).toMatch(/NEVER authorization to implement/i);
        expect(prompt).toMatch(/explicitly approves/i);
        expect(configString(gate, 'outputKey')).toBe('plan.ready');
    });

    it('write-plan runs AFTER approval and commits .omo/plans/<slug>.md', () => {
        const graph = createPlannerWorkflowGraph();
        const writePlan = findNode(graph, 'write-plan');
        const prompt = configString(writePlan, 'systemPrompt') ?? '';
        expect(prompt).toMatch(/AFTER approval/i);
        expect(prompt).toMatch(/\.omo\/plans/);
        expect(configString(writePlan, 'outputKey')).toBe('plan.written');
    });
});

describe('planner workflow parity: scaffold-compatible plan output', () => {
    it('PLANNER_SCAFFOLD_HEADERS carries the full scaffold in order', () => {
        expect(PLANNER_SCAFFOLD_HEADERS).toEqual([
            '# <slug> - Work Plan',
            '## TL;DR (For humans)',
            '## Scope',
            '## Verification Strategy',
            '## Execution Strategy',
            '## Todos',
            '## Final Verification Wave',
            '## Commit Strategy',
            '## Success Criteria',
        ]);
    });

    it('write-plan prompt names every scaffold header', () => {
        const graph = createPlannerWorkflowGraph();
        const prompt = configString(findNode(graph, 'write-plan'), 'systemPrompt') ?? '';
        for (const header of PLANNER_SCAFFOLD_HEADERS) {
            expect(prompt).toContain(header);
        }
    });

    it('write-plan prompt requires Must have / Must NOT have scope and checkbox todos', () => {
        const graph = createPlannerWorkflowGraph();
        const prompt = configString(findNode(graph, 'write-plan'), 'systemPrompt') ?? '';
        expect(prompt).toMatch(/Must have.*Must NOT have|Must NOT have/i);
        expect(prompt).toMatch(/- \[ \]/);
        expect(prompt).toMatch(/References.*Acceptance criteria.*QA/i);
    });

    it('write-plan prompt declares the F1-F4 final verification wave', () => {
        const graph = createPlannerWorkflowGraph();
        const prompt = configString(findNode(graph, 'write-plan'), 'systemPrompt') ?? '';
        expect(prompt).toMatch(/F1 plan-compliance/);
        expect(prompt).toMatch(/F2 code-quality/);
        expect(prompt).toMatch(/F3 real manual QA/);
        expect(prompt).toMatch(/F4 scope-fidelity/);
    });
});

describe('planner workflow parity: planner-readonly child consultations', () => {
    it('PLANNER_READONLY_CHILD_CONTEXT names the inherited boundary and the three roots', () => {
        expect(PLANNER_READONLY_CHILD_CONTEXT).toMatch(/INHERITS.*planner-readonly/i);
        expect(PLANNER_READONLY_CHILD_CONTEXT).toMatch(/\.omo\/plans\/\*\*/);
        expect(PLANNER_READONLY_CHILD_CONTEXT).toMatch(/\.omo\/specs\/\*\*/);
        expect(PLANNER_READONLY_CHILD_CONTEXT).toMatch(/\.omo\/drafts\/\*\*/);
        expect(PLANNER_READONLY_CHILD_CONTEXT).toMatch(/read-only research/i);
    });

    it('explore prompt carries the planner-readonly child context', () => {
        const graph = createPlannerWorkflowGraph();
        const prompt = configString(findNode(graph, 'explore'), 'systemPrompt') ?? '';
        expect(prompt).toContain(PLANNER_READONLY_CHILD_CONTEXT);
    });

    it('research prompt carries the planner-readonly child context', () => {
        const graph = createPlannerWorkflowGraph();
        const prompt = configString(findNode(graph, 'research'), 'systemPrompt') ?? '';
        expect(prompt).toContain(PLANNER_READONLY_CHILD_CONTEXT);
    });
});

describe('planner workflow parity: runtime outputKey persistence', () => {
    afterEach(() => {
        createCompositeNodeTestContext();
    });

    it('draft-plan llm-actor writes plan.drafted to the blackboard from a model turn', async () => {
        const graph = createPlannerWorkflowGraph();
        const draftPlan = findNode(graph, 'draft-plan');
        const context = runContextWithMessages([
            { role: 'user', content: 'draft the plan' },
        ]);
        await collectSignals(runLlmActorNode(draftPlan, context));
        expect(context.blackboard?.get('plan.drafted')).toBe(true);
    });

    it('approval-gate llm-actor writes plan.ready=true to the blackboard when the model approves', async () => {
        const graph = createPlannerWorkflowGraph();
        const approvalGate = findNode(graph, 'approval-gate');
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'approve' }] as readonly ModelMessage[]);
        const context: AbgNodeRunContext = {
            graphId: 'planner-parity-approve',
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
    });

    it('approval-gate llm-actor writes plan.ready=false when the model defers (gate stays closed)', async () => {
        const graph = createPlannerWorkflowGraph();
        const approvalGate = findNode(graph, 'approval-gate');
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'present brief' }] as readonly ModelMessage[]);
        const context: AbgNodeRunContext = {
            graphId: 'planner-parity-defer',
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
        await collectSignals(runLlmActorNode(approvalGate, context));
        expect(blackboard.get('plan.ready')).toBe(false);
    });
});
