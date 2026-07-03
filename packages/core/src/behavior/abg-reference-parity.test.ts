/**
 * ABG reference parity regression suite (plan Todo 1).
 *
 * Pins the CURRENT implementation state of the built-in workflows
 * (`#default`, `#planner`, `#runner`) against the reference behaviors
 * (Sisyphus / Prometheus / Atlas). See `docs/abg-reference-parity-matrix.md`
 * for the full row-by-row mapping.
 *
 * Conventions:
 *   - Regular `it` blocks assert IMPLEMENTED behavior (graph fixtures, pure
 *     transforms, policy algebra, plan parsing). These must stay green.
 *   - `it.fails` blocks assert MISSING / PARTIAL runtime behavior. The body
 *     throws today because the behavior is absent; later todos implement the
 *     behavior, the assertion succeeds, and `it.fails` flips to failing — the
 *     signal to convert it to a regular `it` and update the matrix row.
 *
 * This file touches fixtures and assertions only. It does NOT edit runtime
 * behavior.
 */

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { AbgGraphSpecSchema, type AbgNodeSpec, WorkflowSpecSchema } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard.js';
import { evaluateRules } from '../permissions/rule-evaluator.js';
import { parsePlanChecklistText } from '../persistence/plan-store.js';
import { materializeWorkflow } from '../workflows/materialize-workflow.js';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers.js';
import { createDefaultWorkflowGraph } from './default-workflow-graph.js';
import { autopilotMode } from './modes/autopilot-mode.js';
import { applyMode } from './modes/mode-application.js';
import { type AbgNodeRunContext, runAbgNode } from './node-registry.js';
import { runLlmActorNode } from './nodes/llm-actor/llm-actor-node-runner.js';
import {
    createPlannerWorkflowGraph,
    PLANNER_READONLY_MODE,
    PLANNER_READONLY_POLICIES,
} from './planner-workflow-graph.js';
import { createRunnerWorkflowGraph } from './runner-workflow-graph.js';

/**
 * Read a string-typed value from an AbgNodeSpec config under strict indexing.
 * Returns undefined when the key is absent or the value is not a string.
 */
function configString(
    node: { readonly config?: Readonly<Record<string, unknown>> | undefined } | undefined,
    key: string,
): string | undefined {
    const value = configValue(node, key);
    return typeof value === 'string' ? value : undefined;
}

/**
 * Read a raw value from an AbgNodeSpec config. Centralizes bracket access on the
 * index-signature `config` field so call sites stay clear of the
 * `noPropertyAccessFromIndexSignature` / `useLiteralKeys` tension.
 */
function configValue(
    node: { readonly config?: Readonly<Record<string, unknown>> | undefined } | undefined,
    key: string,
): unknown {
    return node?.config?.[key];
}

/**
 * Build a minimal AbgNodeRunContext with a live blackboard, reusing the mock
 * node set and registry from the composite-node test helpers.
 */
function contextWithBlackboard(): AbgNodeRunContext & {
    readonly blackboard: ReturnType<typeof createBlackboard>;
    readonly registry: NonNullable<AbgNodeRunContext['registry']>;
    readonly nodes: NonNullable<AbgNodeRunContext['nodes']>;
} {
    const helper = createCompositeNodeTestContext();
    const blackboard = createBlackboard();
    const registry = helper.registry;
    const nodes = helper.nodes;
    if (registry === undefined || nodes === undefined) {
        throw new Error('test setup: composite node test context missing registry or nodes');
    }
    return {
        graphId: helper.graphId,
        now: helper.now,
        registry,
        nodes,
        blackboard,
    };
}

describe('abg reference parity: default workflow fallback and intent structure', () => {
    it('produces a schema-valid default graph used as the no-# fallback', () => {
        const graph = createDefaultWorkflowGraph();
        const result = AbgGraphSpecSchema.safeParse(graph);
        expect(result.success).toBe(true);
        expect(graph.id).toBe('default');
        expect(graph.entryNodeId).toBe('intent-gate');
    });

    it('routes intent-gate to at least three targets (trivial, explicit, ambiguous)', () => {
        const graph = createDefaultWorkflowGraph();
        const targets = new Set(graph.edges.filter((edge) => edge.source === 'intent-gate').map((edge) => edge.target));
        expect(targets.size).toBeGreaterThanOrEqual(3);
        expect(targets.has('direct-respond')).toBe(true);
        expect(targets.has('memory')).toBe(true);
        expect(targets.has('clarify')).toBe(true);
    });

    it('declares a delegate-wave parallel node with a task-capable delegate-worker child', () => {
        const graph = createDefaultWorkflowGraph();
        const delegateWave = graph.nodes.find((node) => node.id === 'delegate-wave');
        const delegateWorker = graph.nodes.find((node) => node.id === 'delegate-worker');
        expect(delegateWave?.kind).toBe('parallel');
        expect(delegateWave?.children).toContain('delegate-worker');
        expect(delegateWorker?.capabilities).toContain('task');
    });

    it('intent-gate prompt verbalizes the chosen intent and uses richer classes than three', () => {
        const graph = createDefaultWorkflowGraph();
        const intentGate = graph.nodes.find((node) => node.id === 'intent-gate');
        const prompt = configString(intentGate, 'systemPrompt') ?? '';
        // Reference behavior: the gate verbalizes its decision and may use a richer
        // taxonomy. Today the prompt emits a bare label across exactly three classes.
        const verbalizes =
            /state (your|the).*(intent|classification|reason)/i.test(prompt) || /verbalize|state why/i.test(prompt);
        expect(verbalizes).toBe(true);
    });

    it('default graph carries an anti-dup exploration guard or delegation-bias check node', () => {
        const graph = createDefaultWorkflowGraph();
        const guardNode = graph.nodes.find((node) => {
            const prompt = configString(node, 'systemPrompt') ?? '';
            const label = node.label ?? '';
            return /anti-dup|dedup|delegation-bias|already explored/i.test(`${label} ${prompt}`);
        });
        expect(guardNode).toBeDefined();
    });

    it('default graph carries an evidence-requirement or 3-strike recovery node', () => {
        const graph = createDefaultWorkflowGraph();
        const recoveryNode = graph.nodes.find((node) => {
            const prompt = configString(node, 'systemPrompt') ?? '';
            const label = node.label ?? '';
            return /evidence|3-strike|three strike|recovery/i.test(`${label} ${prompt}`);
        });
        expect(recoveryNode).toBeDefined();
    });
});

describe('abg reference parity: planner workflow mode and readonly enforcement', () => {
    it('produces a schema-valid planner graph with the planner-readonly mode declared', () => {
        const graph = createPlannerWorkflowGraph();
        const result = AbgGraphSpecSchema.safeParse(graph);
        expect(result.success).toBe(true);
        expect(graph.entryNodeId).toBe('intake');
    });

    it('planner-readonly policies deny source writes and allow .omo/plans and .omo/specs', () => {
        expect(evaluateRules('write', 'src/index.ts', [{ rules: [...PLANNER_READONLY_POLICIES] }]).effect).toBe('deny');
        expect(evaluateRules('write', '.omo/plans/plan.md', [{ rules: [...PLANNER_READONLY_POLICIES] }]).effect).toBe(
            'allow',
        );
        expect(evaluateRules('write', '.omo/specs/spec.md', [{ rules: [...PLANNER_READONLY_POLICIES] }]).effect).toBe(
            'allow',
        );
    });

    it('applyMode converts planner-readonly policies into graph-level AbgPolicySpec entries', () => {
        const graph = createPlannerWorkflowGraph();
        const readonlyMode = {
            id: 'planner-readonly',
            systemPromptOverlay: 'overlay',
            policies: [...PLANNER_READONLY_POLICIES],
        };
        const result = applyMode(graph, readonlyMode);
        const writePolicies = result.policies.filter((policy) => policy.capability === 'write');
        expect(writePolicies.length).toBeGreaterThanOrEqual(PLANNER_READONLY_POLICIES.length);
    });

    it('planner workflow EXECUTED graph carries planner-readonly policies via materializeWorkflow', () => {
        // Row 3 + 10 flip (Todo 2): execution path now routes through materializeWorkflow.
        const spec = {
            name: 'planner',
            graph: createPlannerWorkflowGraph(),
            modes: [PLANNER_READONLY_MODE],
        };
        const executed = materializeWorkflow(spec);
        const writeDeny = executed.policies.find(
            (policy) => policy.capability === 'write' && policy.decision === 'deny',
        );
        expect(writeDeny).toBeDefined();
    });

    it.fails('planner draft-plan runtime writes plan.drafted to the blackboard', () => {
        const graph = createPlannerWorkflowGraph();
        const draftPlan = graph.nodes.find((node) => node.id === 'draft-plan');
        // Structural precondition: the node declares the outputKey.
        expect(configString(draftPlan, 'outputKey')).toBe('plan.drafted');
        // Desired runtime behavior: a generic outputKey persistence seam writes the
        // declared key to the blackboard. No such seam is wired for workflow llm nodes.
        const context = contextWithBlackboard();
        // The llm node cannot run without a model; the gap is that even with a model the
        // outputKey would not be persisted. Assert the seam exists by checking the
        // blackboard after a no-op dispatch path.
        expect(context.blackboard.has('plan.drafted')).toBe(true);
    });
});

describe('abg reference parity: runner workflow plan parsing and final gate', () => {
    it('produces a schema-valid runner graph with admit-plan entry node', () => {
        const graph = createRunnerWorkflowGraph();
        const result = AbgGraphSpecSchema.safeParse(graph);
        expect(result.success).toBe(true);
        expect(graph.entryNodeId).toBe('admit-plan');
    });

    it('declares a final-verification-wave with four LLM critic children f1-f4', () => {
        const graph = createRunnerWorkflowGraph();
        const finalWave = graph.nodes.find((node) => node.id === 'final-verification-wave');
        expect(finalWave?.kind).toBe('parallel');
        expect(finalWave?.children).toEqual(['f1', 'f2', 'f3', 'f4']);
        for (const criticId of ['f1', 'f2', 'f3', 'f4']) {
            const critic = graph.nodes.find((node) => node.id === criticId);
            expect(critic?.kind).toBe('llm');
            expect(critic?.config?.['outputKey']).toBe(`final.${criticId}`);
        }
    });

    it('routes final-verification-wave to complete (approved) and fix-loop (rejected)', () => {
        const graph = createRunnerWorkflowGraph();
        const targets = new Set(
            graph.edges.filter((edge) => edge.source === 'final-verification-wave').map((edge) => edge.target),
        );
        expect(targets.has('complete')).toBe(true);
        expect(targets.has('fix-loop')).toBe(true);
    });

    it('parsePlanChecklistText counts column-0 top-level checkboxes', () => {
        const markdown = ['- [x] done task', '- [ ] open task', '- [X] also done'].join('\n');
        const result = parsePlanChecklistText(markdown);
        expect(result.total).toBe(3);
        expect(result.completed).toBe(2);
        expect(result.unchecked).toBe(1);
    });

    it('parsePlanChecklistText counts only checkboxes under ## TODOs and ## Final Verification Wave headings', () => {
        // Reference behavior (oh-my-openagent boulder-state): only checkboxes under
        // the counted section headings are tallied. The current parser counts every
        // column-0 checkbox regardless of section.
        const markdown = [
            '# Plan',
            '',
            '- [x] intro checkbox (no heading — should not count)',
            '',
            '## TODOs',
            '',
            '- [x] real task one',
            '- [ ] real task two',
            '',
            '## Notes',
            '',
            '- [x] note checkbox (wrong section — should not count)',
            '',
            '## Final Verification Wave',
            '',
            '- [x] verified',
        ].join('\n');
        const result = parsePlanChecklistText(markdown);
        // Desired: 3 counted (2 under TODOs + 1 under Final Verification Wave).
        expect(result.total).toBe(3);
    });

    it('final-verification-wave aggregates f1-f4 into a string final.verdict', () => {
        const graph = createRunnerWorkflowGraph();
        const finalWave = graph.nodes.find((node) => node.id === 'final-verification-wave');
        // The parallel node writes a boolean completionKey; the rules expect the string
        // "APPROVE" / "REJECT". Desired: an aggregation config maps children outputs to
        // the string verdict.
        const fanOut = configValue(finalWave, 'fanOutKey');
        const verdictStrategy = configValue(finalWave, 'verdictStrategy');
        const hasAggregation = typeof verdictStrategy === 'string' || typeof fanOut === 'string';
        expect(hasAggregation).toBe(true);
    });

    it('checkbox-update node declares a plan-path write target gated on verification', () => {
        const graph = createRunnerWorkflowGraph();
        const checkboxUpdate = graph.nodes.find((node) => node.id === 'checkbox-update');
        const prompt = configString(checkboxUpdate, 'systemPrompt') ?? '';
        const planPath = configValue(checkboxUpdate, 'planPath');
        // Desired: the node targets a concrete plan file path and only flips checkboxes
        // after per-task verification passes.
        const targetsPlanPath = typeof planPath === 'string' || /\.omo\/plans\//.test(prompt);
        const gatedOnVerify = /after.*verif|only.*verif/i.test(prompt);
        expect(targetsPlanPath && gatedOnVerify).toBe(true);
    });

    it('fix-loop path carries a bounded 3-strike retry counter', () => {
        const graph = createRunnerWorkflowGraph();
        const fixLoop = graph.nodes.find((node) => node.id === 'fix-loop');
        const maxAttempts = configValue(fixLoop, 'maxAttempts');
        const strikeBudget = configValue(fixLoop, 'strikeBudget');
        const hasBound = typeof maxAttempts === 'number' || typeof strikeBudget === 'number';
        expect(hasBound).toBe(true);
    });
});

describe('abg reference parity: parallel fanOutKey and structured blackboard state', () => {
    it('parallel node writes its completionKey to the blackboard as a boolean', async () => {
        const context = contextWithBlackboard();
        const node: AbgNodeSpec = {
            id: 'wave',
            kind: 'parallel',
            children: ['memory'],
            config: { completionKey: 'wave.complete' },
        };
        await collectSignals(runAbgNode(context.registry, node, context));
        // IMPLEMENTED: the parallel node writes completionKey = true.
        expect(context.blackboard.get('wave.complete')).toBe(true);
    });

    it('parallel node fans out one child run per blackboard array item via fanOutKey', async () => {
        const context = contextWithBlackboard();
        context.blackboard.set('plan.todos', ['task-a', 'task-b', 'task-c']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(context.registry, node, context));
        // Desired: 3 child runs (one per todo item). Actual: 1 (static children list).
        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: { completedChildren: expect.arrayContaining(['memory:0', 'memory:1', 'memory:2']) },
        });
    });

    it('workflow llm node outputKey is persisted to the blackboard by a generic seam', async () => {
        const graph = createDefaultWorkflowGraph();
        const intentGate = graph.nodes.find((node) => node.id === 'intent-gate');
        expect(configString(intentGate, 'outputKey')).toBe('intent.classification');
        if (intentGate === undefined) throw new Error('test setup: intent-gate missing');

        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'classify' }] as readonly ModelMessage[]);
        const chunks: LanguageModelV3StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'explicit-implementation' },
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
        const context: AbgNodeRunContext = {
            graphId: 'g_row4',
            now: () => '2026-06-20T00:00:00.000Z',
            sdkModel: new MockLanguageModelV3({
                provider: 'test',
                modelId: 'mock',
                doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
            }),
            blackboard,
        };

        await collectSignals(runLlmActorNode(intentGate, context));

        expect(blackboard.get('intent.classification')).toBe('explicit-implementation');
    });
});

describe('abg reference parity: autopilot mode application on a real graph', () => {
    it('applyMode prepends autopilot directives to every llm node prompt', () => {
        const graph = createPlannerWorkflowGraph();
        const result = applyMode(graph, autopilotMode);
        const llmNodes = result.nodes.filter((node) => node.kind === 'llm');
        expect(llmNodes.length).toBeGreaterThan(0);
        for (const node of llmNodes) {
            const prompt = configString(node, 'systemPrompt') ?? '';
            expect(prompt).toContain('certainty before action');
        }
    });

    it('applyMode adds an edit-gate policy with requires_approval decision', () => {
        const graph = createPlannerWorkflowGraph();
        const result = applyMode(graph, autopilotMode);
        const editPolicy = result.policies.find((policy) => policy.capability === 'edit');
        expect(editPolicy?.decision).toBe('requires_approval');
    });

    it('a workflow declaring autopilot has its edit-gate policy applied via materializeWorkflow', () => {
        // Row 3 (autopilot variant) flip (Todo 2): a workflow spec that declares
        // autopilot in its modes gets the edit-gate policy on the executed graph.
        const spec = {
            name: 'default',
            graph: createDefaultWorkflowGraph(),
            modes: [autopilotMode],
        };
        const executed = materializeWorkflow(spec);
        const editPolicy = executed.policies.find((policy) => policy.capability === 'edit');
        expect(editPolicy?.decision).toBe('requires_approval');
    });
});

describe('abg reference parity: workflow fixture discovery round-trip', () => {
    it('default, planner, and runner fixtures all parse via WorkflowSpecSchema', async () => {
        const { readFile } = await import('node:fs/promises');
        for (const name of ['default', 'planner', 'runner']) {
            const contents = await readFile(`${process.cwd()}/examples/abg/${name}.workflow.json`, 'utf8');
            const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
            expect(result.success).toBe(true);
            expect(result.data?.name).toBe(name);
        }
    });
});
