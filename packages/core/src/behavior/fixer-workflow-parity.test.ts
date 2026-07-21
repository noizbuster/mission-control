// allow: SIZE_OK -- HEAD 393 -> current ~596 pure LOC; one byte-parity and progress-contract matrix for the declarative fixer workflow graph.
/**
 * Fixer workflow parity — behavioral proofs for the richer intent routing
 * (intent-gated implement/fix path with 5-class gate and verification loop).
 *
 * Proves the contract the expanded graph must satisfy:
 *   - 5 intent classes each route to the correct target via a matching rule.
 *   - Exploratory-research routes read-only and can NEVER reach delegation/edits.
 *   - Open-ended-planning routes to #planner/one-question and can NEVER implement.
 *   - Explicit-implementation creates structured todos + delegation + verification.
 *   - A 3-strike recovery ceiling bounds the supervisor.
 *   - The final response cites evidence.
 *   - The runtime blackboard seam writes the new class labels end-to-end.
 *   - Progress-contract matrix: equals-routed llm keys declare outputEnum/shape;
 *     supervisor.action is non-llm; invalid intent fails closed (no silent complete).
 *
 * Structural assertions (edges/rules/capabilities) are the primary proof because
 * the graph is declarative; a reachability walk proves no implementation path leaks
 * out of the read-only / planning branches. The runtime block uses MockLanguageModelV3
 * to prove the outputKey seam persists the new class labels.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
    AbgGraphSpecSchema,
    type AbgNodeSpec,
    type AbgRuleSpec,
    type AbgSignal,
    WorkflowSpecSchema,
} from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers';
import { createFixerWorkflowGraph, FIXER_WORKFLOW_STRIKE_BUDGET } from './fixer-workflow-graph';
import { runAbgGraph } from './graph-runner';
import type { AbgNodeRunContext } from './node-registry';
import { createAbgNodeRegistry } from './node-registry';
import { runLlmActorNode } from './nodes/llm-actor/llm-actor-node-runner';
import { READONLY_TASK_CHILD_CONTEXT } from './readonly-task-child-context';
import { readFile } from 'node:fs/promises';

const INTENT_CLASSES = [
    'trivial',
    'exploratory-research',
    'open-ended-planning',
    'explicit-implementation',
    'ambiguous',
] as const;
type IntentClass = (typeof INTENT_CLASSES)[number];

const workflowJsonPath = `${process.cwd()}/examples/abg/fixer.workflow.json`;

const INTENT_TARGET: Record<IntentClass, string> = {
    trivial: 'direct-respond',
    'exploratory-research': 'research-explore',
    'open-ended-planning': 'route-planner',
    'explicit-implementation': 'memory',
    ambiguous: 'clarify',
};

function configString(node: AbgNodeSpec | undefined, key: string): string | undefined {
    const value = node?.config?.[key];
    return typeof value === 'string' ? value : undefined;
}

function configValue(node: AbgNodeSpec | undefined, key: string): unknown {
    return node?.config?.[key];
}

function findNode(graph: ReturnType<typeof createFixerWorkflowGraph>, id: string): AbgNodeSpec {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) {
        throw new Error(`test setup: node '${id}' missing from fixer graph`);
    }
    return node;
}

function edgesFrom(graph: ReturnType<typeof createFixerWorkflowGraph>, source: string) {
    return graph.edges.filter((edge) => edge.source === source);
}

function ruleById(graph: ReturnType<typeof createFixerWorkflowGraph>, id: string): AbgRuleSpec {
    const rule = graph.rules.find((candidate) => candidate.id === id);
    if (rule === undefined) {
        throw new Error(`test setup: rule '${id}' missing from fixer graph`);
    }
    return rule;
}

/**
 * BFS reachability over the graph's directed edges. Returns the set of node ids
 * reachable from `start` (excluding `start` itself unless a cycle returns to it).
 */
function reachableTargets(graph: ReturnType<typeof createFixerWorkflowGraph>, start: string): Set<string> {
    const visited = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) break;
        for (const edge of edgesFrom(graph, current)) {
            if (!visited.has(edge.target)) {
                visited.add(edge.target);
                queue.push(edge.target);
            }
        }
    }
    return visited;
}

/**
 * Evaluate the subset of AbgRulePredicate kinds the fixer graph uses
 * (`blackboard.value.equals` and `blackboard.key.exists`) against a blackboard
 * snapshot. Mirrors the coordinator's predicate semantics for the routing proof.
 */
function ruleMatches(
    rule: AbgRuleSpec,
    blackboard: { has: (key: string) => boolean; get: (key: string) => unknown },
): boolean {
    const predicate = rule.when;
    if (predicate.kind === 'blackboard.value.equals') {
        return blackboard.get(predicate.key) === predicate.value;
    }
    if (predicate.kind === 'blackboard.key.exists') {
        return blackboard.has(predicate.key);
    }
    return false;
}

describe('fixer workflow parity — schema and structure', () => {
    it('produces a schema-valid graph with intent-gate as entry node', () => {
        const graph = createFixerWorkflowGraph();
        const result = AbgGraphSpecSchema.safeParse(graph);
        expect(result.success).toBe(true);
        expect(graph.entryNodeId).toBe('intent-gate');
    });

    it('declares llm + parallel + memory kinds and critic + supervisor implementations', () => {
        const graph = createFixerWorkflowGraph();
        const kinds = new Set(graph.nodes.map((node) => node.kind));
        const implementations = new Set(
            graph.nodes.map((node) => node.implementation).filter((value): value is string => value !== undefined),
        );
        expect(kinds.has('llm')).toBe(true);
        expect(kinds.has('parallel')).toBe(true);
        expect(kinds.has('memory')).toBe(true);
        expect(implementations.has('critic')).toBe(true);
        expect(implementations.has('supervisor')).toBe(true);
    });

    it('keeps direct-respond, memory, and clarify as intent-gate targets (backward compat)', () => {
        const graph = createFixerWorkflowGraph();
        const targets = new Set(edgesFrom(graph, 'intent-gate').map((edge) => edge.target));
        expect(targets.has('direct-respond')).toBe(true);
        expect(targets.has('memory')).toBe(true);
        expect(targets.has('clarify')).toBe(true);
    });
});

describe('fixer workflow fixture parity', () => {
    it('matches createFixerWorkflowGraph() and declares no modes', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }
        expect(result.data.graph).toEqual(createFixerWorkflowGraph());
        expect(result.data.modes === undefined || result.data.modes.length === 0).toBe(true);
    });
});

describe('fixer workflow parity — five richer intent classes route correctly', () => {
    it('intent-gate prompt requires a strict single-line classification', () => {
        const graph = createFixerWorkflowGraph();
        const prompt = configString(findNode(graph, 'intent-gate'), 'systemPrompt') ?? '';
        expect(prompt).toMatch(/Output ONLY one class name/i);
        expect(prompt).not.toMatch(/LAST line/i);
    });

    it('intent-gate prompt names all five intent classes', () => {
        const graph = createFixerWorkflowGraph();
        const prompt = configString(findNode(graph, 'intent-gate'), 'systemPrompt') ?? '';
        for (const intentClass of INTENT_CLASSES) {
            expect(prompt).toContain(intentClass);
        }
    });

    it.each(INTENT_CLASSES)('routes %s intent to the correct target via a matching rule', (intentClass) => {
        const graph = createFixerWorkflowGraph();
        const expectedTarget = INTENT_TARGET[intentClass];

        const edge = edgesFrom(graph, 'intent-gate').find((candidate) => candidate.target === expectedTarget);
        expect(edge, `intent-gate must edge to ${expectedTarget} for ${intentClass}`).toBeDefined();
        if (edge === undefined) return;
        expect(edge.condition).toBeDefined();

        const rule = ruleById(graph, edge.condition ?? '');
        const predicate = rule.when;
        expect(predicate.kind).toBe('blackboard.value.equals');
        if (predicate.kind !== 'blackboard.value.equals') return;
        expect(predicate.key).toBe('intent.classification');
        expect(predicate.value).toBe(intentClass);
    });

    it.each(INTENT_CLASSES)('the %s rule fires only when intent.classification equals that class', (intentClass) => {
        const graph = createFixerWorkflowGraph();
        const blackboard = createBlackboard();

        blackboard.set('intent.classification', intentClass);
        const matchingRule = graph.rules.find(
            (rule) => rule.when.kind === 'blackboard.value.equals' && rule.when.value === intentClass,
        );
        expect(matchingRule, `rule for ${intentClass} must exist`).toBeDefined();
        if (matchingRule === undefined) return;
        expect(ruleMatches(matchingRule, blackboard)).toBe(true);

        for (const other of INTENT_CLASSES) {
            if (other === intentClass) continue;
            blackboard.set('intent.classification', other);
            expect(ruleMatches(matchingRule, blackboard)).toBe(false);
        }
    });
});

describe('fixer workflow parity — exploratory-research routes read-only, never edits', () => {
    it('research-explore declares exact read+subagent+network capabilities (no write/edit/patch/bash)', () => {
        const graph = createFixerWorkflowGraph();
        const capabilities = findNode(graph, 'research-explore').capabilities ?? [];
        expect(capabilities).toEqual(['read', 'subagent', 'network']);
        const forbidden = ['write', 'edit', 'patch', 'bash'];
        for (const cap of forbidden) {
            expect(capabilities, `research-explore must not declare ${cap}`).not.toContain(cap);
        }
    });

    it('research-explore prompt forbids edits and carries explore/librarian + readonly child context', () => {
        const graph = createFixerWorkflowGraph();
        const prompt = configString(findNode(graph, 'research-explore'), 'systemPrompt') ?? '';
        expect(/must not edit|never edit|read-only/i.test(prompt)).toBe(true);
        expect(prompt).toContain(READONLY_TASK_CHILD_CONTEXT);
        expect(prompt).toContain('category:"explore"');
        expect(prompt).toContain('category:"librarian"');
        expect(prompt).toMatch(/Never\s+task\(category:"deep"\)/i);
        expect(prompt).toMatch(/before final synthesis/i);
    });

    it('delegate-wave and delegate-worker are NOT reachable from research-explore', () => {
        const graph = createFixerWorkflowGraph();
        const reachable = reachableTargets(graph, 'research-explore');
        expect(reachable.has('delegate-wave')).toBe(false);
        expect(reachable.has('delegate-worker')).toBe(false);
        expect(reachable.has('todo-plan')).toBe(false);
    });

    it('research-explore reaches final-respond (synthesis, no implementation)', () => {
        const graph = createFixerWorkflowGraph();
        expect(edgesFrom(graph, 'research-explore').map((edge) => edge.target)).toEqual([
            'final-respond',
            'research-explore',
        ]);
        const reachable = reachableTargets(graph, 'research-explore');
        expect(reachable.has('final-respond')).toBe(true);
    });

    it('research-explore requires boolean explore.complete === true (not key.exists)', () => {
        const graph = createFixerWorkflowGraph();
        const node = findNode(graph, 'research-explore');
        expect(configString(node, 'outputKey')).toBe('explore.complete');
        expect(configString(node, 'outputShape')).toBe('boolean');
        expect(configValue(node, 'outputDefault')).toBeUndefined();
        const rule = ruleById(graph, 'research-complete');
        expect(rule.when).toEqual({
            kind: 'blackboard.value.equals',
            key: 'explore.complete',
            value: true,
        });
    });
});

describe('fixer workflow parity — open-ended-planning routes to planning, never implements', () => {
    it('route-planner declares workflow capability, not task/write/edit', () => {
        const graph = createFixerWorkflowGraph();
        const capabilities = findNode(graph, 'route-planner').capabilities ?? [];
        expect(capabilities).toContain('workflow');
        const forbidden = ['subagent', 'write', 'edit', 'patch', 'bash'];
        for (const cap of forbidden) {
            expect(capabilities, `route-planner must not declare ${cap}`).not.toContain(cap);
        }
    });

    it('route-planner prompt forbids implementing directly', () => {
        const graph = createFixerWorkflowGraph();
        const prompt = configString(findNode(graph, 'route-planner'), 'systemPrompt') ?? '';
        expect(/must not implement|never implement/i.test(prompt)).toBe(true);
    });

    it('route-planner prompt routes to #planner or a single clarifying question', () => {
        const graph = createFixerWorkflowGraph();
        const prompt = configString(findNode(graph, 'route-planner'), 'systemPrompt') ?? '';
        expect(/#planner|planner/i.test(prompt)).toBe(true);
        expect(/one|exactly one/i.test(prompt)).toBe(true);
    });

    it('delegate-wave and todo-plan are NOT reachable from route-planner', () => {
        const graph = createFixerWorkflowGraph();
        const reachable = reachableTargets(graph, 'route-planner');
        expect(reachable.has('delegate-wave')).toBe(false);
        expect(reachable.has('delegate-worker')).toBe(false);
        expect(reachable.has('todo-plan')).toBe(false);
    });
});

describe('fixer workflow parity — explicit-implementation creates todos + delegation + verification', () => {
    it('declares the full explicit-implementation chain as edges', () => {
        const graph = createFixerWorkflowGraph();
        const chain = [
            ['memory', 'maturity-sample'],
            ['maturity-sample', 'maturity-classify'],
            ['maturity-classify', 'anti-dup-guard'],
            ['anti-dup-guard', 'todo-plan'],
            ['todo-plan', 'delegate-wave'],
            ['delegate-wave', 'verify-wave'],
            ['verify-wave', 'evidence-check'],
            ['evidence-check', 'final-respond'],
        ] as const;
        for (const [source, target] of chain) {
            const exists = edgesFrom(graph, source).some((edge) => edge.target === target);
            expect(exists, `edge ${source} -> ${target} must exist`).toBe(true);
        }
    });

    it('todo-plan writes structured todos (plan.todos outputKey + array shape)', () => {
        const graph = createFixerWorkflowGraph();
        expect(configString(findNode(graph, 'todo-plan'), 'outputKey')).toBe('plan.todos');
        expect(configString(findNode(graph, 'todo-plan'), 'outputShape')).toBe('array');
        expect(configValue(findNode(graph, 'delegate-wave'), 'fanOutKey')).toBe('plan.todos');
    });

    it('delegate-wave fans out one task-capable delegate-worker per todo', () => {
        const graph = createFixerWorkflowGraph();
        const delegateWave = findNode(graph, 'delegate-wave');
        expect(delegateWave.kind).toBe('parallel');
        expect(delegateWave.children).toContain('delegate-worker');
        expect(findNode(graph, 'delegate-worker').capabilities).toContain('subagent');
    });

    it('anti-dup-guard node carries anti-dup and delegation-bias semantics', () => {
        const graph = createFixerWorkflowGraph();
        const node = findNode(graph, 'anti-dup-guard');
        const text = `${node.label ?? ''} ${configString(node, 'systemPrompt') ?? ''}`;
        expect(/anti-dup|dedup|already explored/i.test(text)).toBe(true);
        expect(/delegation-bias|delegation bias|delegation/i.test(text)).toBe(true);
    });

    it('maturity-sample is a short read-only hybrid gate before classify', () => {
        const graph = createFixerWorkflowGraph();
        const node = findNode(graph, 'maturity-sample');
        expect(node.capabilities).toEqual(['read']);
        expect(configString(node, 'outputKey')).toBe('explore.sampled');
        expect(configString(node, 'outputShape')).toBe('boolean');
        expect(configValue(node, 'loopActiveSoftLandAttempts')).toBe(5);
        const prompt = configString(node, 'systemPrompt') ?? '';
        expect(/sample/i.test(prompt)).toBe(true);
        expect(/read-only|READ-ONLY/i.test(prompt)).toBe(true);
    });

    it('maturity-classify is a pure structured enum gate after sampling', () => {
        const graph = createFixerWorkflowGraph();
        const node = findNode(graph, 'maturity-classify');
        expect(node.capabilities).toEqual([]);
        const prompt = configString(node, 'systemPrompt') ?? '';
        expect(/disciplined|transitional|legacy|greenfield/i.test(prompt)).toBe(true);
        expect(configString(node, 'outputKey')).toBe('explore.maturity');
        expect(configString(node, 'outputShape')).toBe('string');
        expect(configValue(node, 'outputEnum')).toEqual(['disciplined', 'transitional', 'legacy', 'greenfield']);
        expect(configString(node, 'outputSoftLandDefault')).toBe('transitional');
    });
});

describe('fixer workflow parity — 3-strike failure recovery ceiling', () => {
    it('supervisor declares a bounded strike budget of at least 3', () => {
        const graph = createFixerWorkflowGraph();
        const supervisor = findNode(graph, 'supervisor');
        const maxAttempts = configValue(supervisor, 'maxAttempts');
        const strikeBudget = configValue(supervisor, 'strikeBudget');
        expect(typeof maxAttempts === 'number' && maxAttempts >= 3).toBe(true);
        expect(typeof strikeBudget === 'number' && strikeBudget >= 3).toBe(true);
    });

    it('FIXER_WORKFLOW_STRIKE_BUDGET constant is 3', () => {
        expect(FIXER_WORKFLOW_STRIKE_BUDGET).toBe(3);
    });

    it('both critic-failed and evidence-missing route into the supervisor recovery loop', () => {
        const graph = createFixerWorkflowGraph();
        const toSupervisor = graph.edges.filter((edge) => edge.target === 'supervisor');
        const sources = new Set(toSupervisor.map((edge) => edge.source));
        expect(sources.has('verify-wave')).toBe(true);
        expect(sources.has('evidence-check')).toBe(true);
    });

    it('supervisor can retry (back to delegate-wave) or escalate (to final-respond)', () => {
        const graph = createFixerWorkflowGraph();
        const targets = new Set(edgesFrom(graph, 'supervisor').map((edge) => edge.target));
        expect(targets.has('delegate-wave')).toBe(true);
        expect(targets.has('final-respond')).toBe(true);
    });
});

describe('fixer workflow parity — evidence requirements and final citation', () => {
    it('evidence-check node exists and demands concrete evidence', () => {
        const graph = createFixerWorkflowGraph();
        const node = findNode(graph, 'evidence-check');
        const text = `${node.label ?? ''} ${configString(node, 'systemPrompt') ?? ''}`;
        expect(/evidence/i.test(text)).toBe(true);
        expect(configString(node, 'outputKey')).toBe('evidence.verified');
    });

    it('evidence-check is the gate between critic-passed and final-respond', () => {
        const graph = createFixerWorkflowGraph();
        const fromVerify = edgesFrom(graph, 'verify-wave').map((edge) => edge.target);
        expect(fromVerify).toContain('evidence-check');
        const toFinal = graph.edges.filter((edge) => edge.target === 'final-respond');
        const sources = new Set(toFinal.map((edge) => edge.source));
        expect(sources.has('evidence-check')).toBe(true);
    });

    it('final-respond prompt requires citing evidence', () => {
        const graph = createFixerWorkflowGraph();
        const prompt = configString(findNode(graph, 'final-respond'), 'systemPrompt') ?? '';
        expect(/evidence/i.test(prompt)).toBe(true);
    });
});

describe('fixer workflow parity — runtime blackboard write for the new intent classes', () => {
    it.each(
        INTENT_CLASSES,
    )('intent-gate writes %s to intent.classification and the matching rule fires', async (intentClass) => {
        const graph = createFixerWorkflowGraph();
        const intentGate = findNode(graph, 'intent-gate');
        const { context, blackboard } = contextForIntentGate(intentClass);

        await collectSignals(runLlmActorNode(intentGate, context));

        expect(blackboard.get('intent.classification')).toBe(intentClass);

        const matchingRule = graph.rules.find(
            (rule) => rule.when.kind === 'blackboard.value.equals' && rule.when.value === intentClass,
        );
        expect(matchingRule).toBeDefined();
        if (matchingRule === undefined) return;
        expect(ruleMatches(matchingRule, blackboard)).toBe(true);
    });

    it('intent-gate outputKey stays intent.classification', () => {
        const graph = createFixerWorkflowGraph();
        expect(configString(findNode(graph, 'intent-gate'), 'outputKey')).toBe('intent.classification');
    });
});

const FIXER_EQUALS_ROUTED_LLM_GATES = [
    {
        nodeId: 'intent-gate',
        outputKey: 'intent.classification',
        kind: 'enum' as const,
        outputEnum: ['trivial', 'exploratory-research', 'open-ended-planning', 'explicit-implementation', 'ambiguous'],
    },
    { nodeId: 'research-explore', outputKey: 'explore.complete', kind: 'boolean' as const },
    { nodeId: 'route-planner', outputKey: 'planner.routed', kind: 'boolean' as const },
    { nodeId: 'maturity-sample', outputKey: 'explore.sampled', kind: 'boolean' as const },
    {
        nodeId: 'maturity-classify',
        outputKey: 'explore.maturity',
        kind: 'enum' as const,
        outputEnum: ['disciplined', 'transitional', 'legacy', 'greenfield'],
    },
    { nodeId: 'anti-dup-guard', outputKey: 'guard.cleared', kind: 'boolean' as const },
    { nodeId: 'evidence-check', outputKey: 'evidence.verified', kind: 'boolean' as const },
    { nodeId: 'clarify', outputKey: 'clarify.active', kind: 'boolean' as const },
] as const;

describe('fixer workflow parity — progress-contract routing key matrix', () => {
    it.each(FIXER_EQUALS_ROUTED_LLM_GATES)('$nodeId declares fail-closed shape/enum for $outputKey', (gate) => {
        const graph = createFixerWorkflowGraph();
        const node = findNode(graph, gate.nodeId);
        expect(configString(node, 'outputKey')).toBe(gate.outputKey);
        if (gate.kind === 'boolean') {
            expect(configString(node, 'outputShape')).toBe('boolean');
        } else {
            expect(configValue(node, 'outputEnum')).toEqual([...gate.outputEnum]);
        }
    });

    it('todo-plan keeps array shape for fanOutKey plan.todos (key.exists, not equals)', () => {
        const graph = createFixerWorkflowGraph();
        const node = findNode(graph, 'todo-plan');
        expect(configString(node, 'outputKey')).toBe('plan.todos');
        expect(configString(node, 'outputShape')).toBe('array');
    });

    it('planner-routed requires planner.routed === true (not bare key.exists)', () => {
        const graph = createFixerWorkflowGraph();
        const rule = ruleById(graph, 'planner-routed');
        expect(rule.when).toEqual({
            kind: 'blackboard.value.equals',
            key: 'planner.routed',
            value: true,
        });
    });

    it('clarify-loop requires clarify.active === true with boolean shape', () => {
        const graph = createFixerWorkflowGraph();
        expect(configString(findNode(graph, 'clarify'), 'outputShape')).toBe('boolean');
        const rule = ruleById(graph, 'clarify-loop');
        expect(rule.when).toEqual({
            kind: 'blackboard.value.equals',
            key: 'clarify.active',
            value: true,
        });
    });
});

describe('fixer workflow parity — supervisor.action is non-llm (supervisor-node written)', () => {
    it('supervisor node has implementation supervisor and no llm outputEnum/outputKey', () => {
        const graph = createFixerWorkflowGraph();
        const supervisor = findNode(graph, 'supervisor');
        expect(supervisor.implementation).toBe('supervisor');
        expect(configString(supervisor, 'outputKey')).toBeUndefined();
        expect(configValue(supervisor, 'outputEnum')).toBeUndefined();
        expect(configString(supervisor, 'outputShape')).toBeUndefined();
    });

    it('keeps escalate edges: retry -> delegate-wave, escalated -> final-respond', () => {
        const graph = createFixerWorkflowGraph();
        const retryEdge = edgesFrom(graph, 'supervisor').find((edge) => edge.target === 'delegate-wave');
        const escalateEdge = edgesFrom(graph, 'supervisor').find((edge) => edge.target === 'final-respond');
        expect(retryEdge?.condition).toBe('supervisor-retry');
        expect(escalateEdge?.condition).toBe('supervisor-escalated');

        const retryRule = ruleById(graph, 'supervisor-retry');
        expect(retryRule.when).toEqual({
            kind: 'blackboard.value.equals',
            key: 'supervisor.action',
            value: 'retry',
        });
        const escalateRule = ruleById(graph, 'supervisor-escalated');
        expect(escalateRule.when).toEqual({
            kind: 'blackboard.key.exists',
            key: 'supervisor.escalated',
        });
    });

    it('supervisor-retry fires only for action retry; escalate path uses supervisor.escalated', () => {
        const graph = createFixerWorkflowGraph();
        const blackboard = createBlackboard();
        const retryRule = ruleById(graph, 'supervisor-retry');
        const escalateRule = ruleById(graph, 'supervisor-escalated');

        blackboard.set('supervisor.action', 'retry');
        expect(ruleMatches(retryRule, blackboard)).toBe(true);
        expect(ruleMatches(escalateRule, blackboard)).toBe(false);

        blackboard.set('supervisor.action', 'escalate');
        blackboard.set('supervisor.escalated', true);
        expect(ruleMatches(retryRule, blackboard)).toBe(false);
        expect(ruleMatches(escalateRule, blackboard)).toBe(true);
    });
});

describe('fixer workflow parity — invalid intent fails closed (no silent complete)', () => {
    it('intent-gate rejects non-enum text with invalid_structured_output and no blackboard write', async () => {
        // Given: intent-gate with declared outputEnum; model emits a poison blob
        const graph = createFixerWorkflowGraph();
        const intentGate = findNode(graph, 'intent-gate');
        const { context, blackboard } = contextForIntentGate('{"prose":"not a class"}');

        // When
        const signals = await collectSignals(runLlmActorNode(intentGate, context));

        // Then: fail closed — no poison on the board, typed failure
        expect(blackboard.has('intent.classification')).toBe(false);
        const failure = signals.find((signal) => signal.type === 'failure');
        expect(failure).toMatchObject({
            type: 'failure',
            error: { code: 'invalid_structured_output' },
        });
    });

    it('poison intent.classification with only conditional equals edges does not complete the graph', async () => {
        // Given: fixer-shaped intent gate edges + non-matching poison value (P1 pattern)
        const registry = createAbgNodeRegistry();
        registry.register(
            'write-poison-intent',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('intent.classification', {
                    prose: 'not an intent class',
                    nested: true,
                });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        // When
        const result = await runAbgGraph({
            sessionId: 'session_fixer_invalid_intent',
            now: () => '2026-07-16T00:00:00.000Z',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            registry,
            graph: {
                id: 'fixer-invalid-intent-dead-end',
                entryNodeId: 'intent-gate',
                defaults: { retryLimit: 2 },
                nodes: [
                    {
                        id: 'intent-gate',
                        kind: 'action',
                        implementation: 'write-poison-intent',
                        capabilities: [],
                        config: {
                            outputKey: 'intent.classification',
                            outputEnum: [...INTENT_CLASSES],
                        },
                    },
                    { id: 'direct-respond', kind: 'action' },
                    { id: 'research-explore', kind: 'action' },
                    { id: 'route-planner', kind: 'action' },
                    { id: 'memory', kind: 'action' },
                    { id: 'clarify', kind: 'action' },
                ],
                edges: [
                    { source: 'intent-gate', target: 'direct-respond', condition: 'intent-trivial' },
                    { source: 'intent-gate', target: 'research-explore', condition: 'intent-exploratory' },
                    { source: 'intent-gate', target: 'route-planner', condition: 'intent-open-ended' },
                    {
                        source: 'intent-gate',
                        target: 'memory',
                        condition: 'intent-explicit-implementation',
                    },
                    { source: 'intent-gate', target: 'clarify', condition: 'intent-ambiguous' },
                ],
                rules: [
                    {
                        id: 'intent-trivial',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'intent.classification',
                            value: 'trivial',
                        },
                    },
                    {
                        id: 'intent-exploratory',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'intent.classification',
                            value: 'exploratory-research',
                        },
                    },
                    {
                        id: 'intent-open-ended',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'intent.classification',
                            value: 'open-ended-planning',
                        },
                    },
                    {
                        id: 'intent-explicit-implementation',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'intent.classification',
                            value: 'explicit-implementation',
                        },
                    },
                    {
                        id: 'intent-ambiguous',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'intent.classification',
                            value: 'ambiguous',
                        },
                    },
                ],
                policies: [],
            },
        });

        // Then: dead-end exhaust → typed fail, never silent complete
        expect(result.status).not.toBe('completed');
        expect(result.status).toBe('failed');
        expect(result.terminalError?.code).toBe('routing_dead_end');
        expect(result.events.some((event) => event.abg?.nodeId === 'direct-respond')).toBe(false);
        expect(result.events.some((event) => event.abg?.nodeId === 'memory')).toBe(false);
        expect(result.events.some((event) => event.abg?.nodeId === 'clarify')).toBe(false);
    });
});

function contextForIntentGate(modelText: string): {
    readonly context: AbgNodeRunContext;
    readonly blackboard: ReturnType<typeof createBlackboard>;
} {
    const blackboard = createBlackboard();
    blackboard.appendMessages([{ role: 'user', content: 'classify' }] as readonly ModelMessage[]);
    const chunks: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: modelText },
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
    const helper = createCompositeNodeTestContext();
    const context: AbgNodeRunContext = {
        graphId: helper.graphId,
        now: helper.now,
        sdkModel: new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
        }),
        blackboard,
    };
    return { context, blackboard };
}
