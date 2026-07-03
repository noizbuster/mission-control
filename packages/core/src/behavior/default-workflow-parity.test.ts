/**
 * Default workflow parity — behavioral proofs for the richer intent routing
 * (plan Task 11: port Sisyphus default-workflow behavior into `#default`).
 *
 * Proves the contract the expanded graph must satisfy:
 *   - 5 intent classes each route to the correct target via a matching rule.
 *   - Exploratory-research routes read-only and can NEVER reach delegation/edits.
 *   - Open-ended-planning routes to #planner/one-question and can NEVER implement.
 *   - Explicit-implementation creates structured todos + delegation + verification.
 *   - A 3-strike recovery ceiling bounds the supervisor.
 *   - The final response cites evidence.
 *   - The runtime blackboard seam writes the new class labels end-to-end.
 *
 * Structural assertions (edges/rules/capabilities) are the primary proof because
 * the graph is declarative; a reachability walk proves no implementation path leaks
 * out of the read-only / planning branches. The runtime block uses MockLanguageModelV3
 * to prove the outputKey seam persists the new class labels.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { AbgGraphSpecSchema, type AbgNodeSpec, type AbgRuleSpec } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard.js';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers.js';
import { createDefaultWorkflowGraph, DEFAULT_WORKFLOW_STRIKE_BUDGET } from './default-workflow-graph.js';
import type { AbgNodeRunContext } from './node-registry.js';
import { runLlmActorNode } from './nodes/llm-actor/llm-actor-node-runner.js';

const INTENT_CLASSES = [
    'trivial',
    'exploratory-research',
    'open-ended-planning',
    'explicit-implementation',
    'ambiguous',
] as const;
type IntentClass = (typeof INTENT_CLASSES)[number];

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

function findNode(graph: ReturnType<typeof createDefaultWorkflowGraph>, id: string): AbgNodeSpec {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) {
        throw new Error(`test setup: node '${id}' missing from default graph`);
    }
    return node;
}

function edgesFrom(graph: ReturnType<typeof createDefaultWorkflowGraph>, source: string) {
    return graph.edges.filter((edge) => edge.source === source);
}

function ruleById(graph: ReturnType<typeof createDefaultWorkflowGraph>, id: string): AbgRuleSpec {
    const rule = graph.rules.find((candidate) => candidate.id === id);
    if (rule === undefined) {
        throw new Error(`test setup: rule '${id}' missing from default graph`);
    }
    return rule;
}

/**
 * BFS reachability over the graph's directed edges. Returns the set of node ids
 * reachable from `start` (excluding `start` itself unless a cycle returns to it).
 */
function reachableTargets(graph: ReturnType<typeof createDefaultWorkflowGraph>, start: string): Set<string> {
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
 * Evaluate the subset of AbgRulePredicate kinds the default graph uses
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

describe('default workflow parity — schema and structure', () => {
    it('produces a schema-valid graph with intent-gate as entry node', () => {
        const graph = createDefaultWorkflowGraph();
        const result = AbgGraphSpecSchema.safeParse(graph);
        expect(result.success).toBe(true);
        expect(graph.entryNodeId).toBe('intent-gate');
    });

    it('declares llm + parallel + memory kinds and critic + supervisor implementations', () => {
        const graph = createDefaultWorkflowGraph();
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
        const graph = createDefaultWorkflowGraph();
        const targets = new Set(edgesFrom(graph, 'intent-gate').map((edge) => edge.target));
        expect(targets.has('direct-respond')).toBe(true);
        expect(targets.has('memory')).toBe(true);
        expect(targets.has('clarify')).toBe(true);
    });
});

describe('default workflow parity — five richer intent classes route correctly', () => {
    it('intent-gate prompt verbalizes the chosen intent before classification', () => {
        const graph = createDefaultWorkflowGraph();
        const prompt = configString(findNode(graph, 'intent-gate'), 'systemPrompt') ?? '';
        const verbalizes =
            /state (your|the).*(intent|classification|reason)/i.test(prompt) || /verbalize|state why/i.test(prompt);
        expect(verbalizes).toBe(true);
    });

    it('intent-gate prompt names all five intent classes', () => {
        const graph = createDefaultWorkflowGraph();
        const prompt = configString(findNode(graph, 'intent-gate'), 'systemPrompt') ?? '';
        for (const intentClass of INTENT_CLASSES) {
            expect(prompt).toContain(intentClass);
        }
    });

    it.each(INTENT_CLASSES)('routes %s intent to the correct target via a matching rule', (intentClass) => {
        const graph = createDefaultWorkflowGraph();
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
        const graph = createDefaultWorkflowGraph();
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

describe('default workflow parity — exploratory-research routes read-only, never edits', () => {
    it('research-explore declares only the read capability (no write/edit/patch/bash/task)', () => {
        const graph = createDefaultWorkflowGraph();
        const capabilities = findNode(graph, 'research-explore').capabilities ?? [];
        expect(capabilities).toContain('read');
        const forbidden = ['write', 'edit', 'patch', 'bash', 'task'];
        for (const cap of forbidden) {
            expect(capabilities, `research-explore must not declare ${cap}`).not.toContain(cap);
        }
    });

    it('research-explore prompt forbids edits', () => {
        const graph = createDefaultWorkflowGraph();
        const prompt = configString(findNode(graph, 'research-explore'), 'systemPrompt') ?? '';
        expect(/must not edit|never edit|read-only/i.test(prompt)).toBe(true);
    });

    it('delegate-wave and delegate-worker are NOT reachable from research-explore', () => {
        const graph = createDefaultWorkflowGraph();
        const reachable = reachableTargets(graph, 'research-explore');
        expect(reachable.has('delegate-wave')).toBe(false);
        expect(reachable.has('delegate-worker')).toBe(false);
        expect(reachable.has('todo-plan')).toBe(false);
    });

    it('research-explore reaches final-respond (synthesis, no implementation)', () => {
        const graph = createDefaultWorkflowGraph();
        const reachable = reachableTargets(graph, 'research-explore');
        expect(reachable.has('final-respond')).toBe(true);
    });
});

describe('default workflow parity — open-ended-planning routes to planning, never implements', () => {
    it('route-planner declares workflow capability, not task/write/edit', () => {
        const graph = createDefaultWorkflowGraph();
        const capabilities = findNode(graph, 'route-planner').capabilities ?? [];
        expect(capabilities).toContain('workflow');
        const forbidden = ['task', 'write', 'edit', 'patch', 'bash'];
        for (const cap of forbidden) {
            expect(capabilities, `route-planner must not declare ${cap}`).not.toContain(cap);
        }
    });

    it('route-planner prompt forbids implementing directly', () => {
        const graph = createDefaultWorkflowGraph();
        const prompt = configString(findNode(graph, 'route-planner'), 'systemPrompt') ?? '';
        expect(/must not implement|never implement/i.test(prompt)).toBe(true);
    });

    it('route-planner prompt routes to #planner or a single clarifying question', () => {
        const graph = createDefaultWorkflowGraph();
        const prompt = configString(findNode(graph, 'route-planner'), 'systemPrompt') ?? '';
        expect(/#planner|planner/i.test(prompt)).toBe(true);
        expect(/one|exactly one/i.test(prompt)).toBe(true);
    });

    it('delegate-wave and todo-plan are NOT reachable from route-planner', () => {
        const graph = createDefaultWorkflowGraph();
        const reachable = reachableTargets(graph, 'route-planner');
        expect(reachable.has('delegate-wave')).toBe(false);
        expect(reachable.has('delegate-worker')).toBe(false);
        expect(reachable.has('todo-plan')).toBe(false);
    });
});

describe('default workflow parity — explicit-implementation creates todos + delegation + verification', () => {
    it('declares the full explicit-implementation chain as edges', () => {
        const graph = createDefaultWorkflowGraph();
        const chain = [
            ['memory', 'maturity-check'],
            ['maturity-check', 'anti-dup-guard'],
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

    it('todo-plan writes structured todos (plan.todos fanOutKey + plan.ready outputKey)', () => {
        const graph = createDefaultWorkflowGraph();
        expect(configString(findNode(graph, 'todo-plan'), 'outputKey')).toBe('plan.ready');
        const todoPrompt = configString(findNode(graph, 'todo-plan'), 'systemPrompt') ?? '';
        expect(/plan\.todos/.test(todoPrompt)).toBe(true);
        expect(configValue(findNode(graph, 'delegate-wave'), 'fanOutKey')).toBe('plan.todos');
    });

    it('delegate-wave fans out one task-capable delegate-worker per todo', () => {
        const graph = createDefaultWorkflowGraph();
        const delegateWave = findNode(graph, 'delegate-wave');
        expect(delegateWave.kind).toBe('parallel');
        expect(delegateWave.children).toContain('delegate-worker');
        expect(findNode(graph, 'delegate-worker').capabilities).toContain('task');
    });

    it('anti-dup-guard node carries anti-dup and delegation-bias semantics', () => {
        const graph = createDefaultWorkflowGraph();
        const node = findNode(graph, 'anti-dup-guard');
        const text = `${node.label ?? ''} ${configString(node, 'systemPrompt') ?? ''}`;
        expect(/anti-dup|dedup|already explored/i.test(text)).toBe(true);
        expect(/delegation-bias|delegation bias|delegation/i.test(text)).toBe(true);
    });

    it('maturity-check assesses codebase maturity before implementing', () => {
        const graph = createDefaultWorkflowGraph();
        const node = findNode(graph, 'maturity-check');
        const prompt = configString(node, 'systemPrompt') ?? '';
        expect(/disciplined|transitional|legacy|greenfield/i.test(prompt)).toBe(true);
        expect(configString(node, 'outputKey')).toBe('explore.maturity');
    });
});

describe('default workflow parity — 3-strike failure recovery ceiling', () => {
    it('supervisor declares a bounded strike budget of at least 3', () => {
        const graph = createDefaultWorkflowGraph();
        const supervisor = findNode(graph, 'supervisor');
        const maxAttempts = configValue(supervisor, 'maxAttempts');
        const strikeBudget = configValue(supervisor, 'strikeBudget');
        expect(typeof maxAttempts === 'number' && maxAttempts >= 3).toBe(true);
        expect(typeof strikeBudget === 'number' && strikeBudget >= 3).toBe(true);
    });

    it('DEFAULT_WORKFLOW_STRIKE_BUDGET constant is 3', () => {
        expect(DEFAULT_WORKFLOW_STRIKE_BUDGET).toBe(3);
    });

    it('both critic-failed and evidence-missing route into the supervisor recovery loop', () => {
        const graph = createDefaultWorkflowGraph();
        const toSupervisor = graph.edges.filter((edge) => edge.target === 'supervisor');
        const sources = new Set(toSupervisor.map((edge) => edge.source));
        expect(sources.has('verify-wave')).toBe(true);
        expect(sources.has('evidence-check')).toBe(true);
    });

    it('supervisor can retry (back to delegate-wave) or escalate (to final-respond)', () => {
        const graph = createDefaultWorkflowGraph();
        const targets = new Set(edgesFrom(graph, 'supervisor').map((edge) => edge.target));
        expect(targets.has('delegate-wave')).toBe(true);
        expect(targets.has('final-respond')).toBe(true);
    });
});

describe('default workflow parity — evidence requirements and final citation', () => {
    it('evidence-check node exists and demands concrete evidence', () => {
        const graph = createDefaultWorkflowGraph();
        const node = findNode(graph, 'evidence-check');
        const text = `${node.label ?? ''} ${configString(node, 'systemPrompt') ?? ''}`;
        expect(/evidence/i.test(text)).toBe(true);
        expect(configString(node, 'outputKey')).toBe('evidence.verified');
    });

    it('evidence-check is the gate between critic-passed and final-respond', () => {
        const graph = createDefaultWorkflowGraph();
        const fromVerify = edgesFrom(graph, 'verify-wave').map((edge) => edge.target);
        expect(fromVerify).toContain('evidence-check');
        const toFinal = graph.edges.filter((edge) => edge.target === 'final-respond');
        const sources = new Set(toFinal.map((edge) => edge.source));
        expect(sources.has('evidence-check')).toBe(true);
    });

    it('final-respond prompt requires citing evidence', () => {
        const graph = createDefaultWorkflowGraph();
        const prompt = configString(findNode(graph, 'final-respond'), 'systemPrompt') ?? '';
        expect(/evidence/i.test(prompt)).toBe(true);
    });
});

describe('default workflow parity — runtime blackboard write for the new intent classes', () => {
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

    it.each(
        INTENT_CLASSES,
    )('intent-gate writes %s to intent.classification and the matching rule fires', async (intentClass) => {
        const graph = createDefaultWorkflowGraph();
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
        const graph = createDefaultWorkflowGraph();
        expect(configString(findNode(graph, 'intent-gate'), 'outputKey')).toBe('intent.classification');
    });
});
