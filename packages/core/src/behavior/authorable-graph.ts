import {
    type AbgGraphSpec,
    AbgGraphSpecSchema,
    type AbgNodeModelOptions,
    type AbgNodeSpec,
} from '@mission-control/protocol';
import type { AgentModelLookup } from './agent-model-resolver.js';
import { resolveGraphAgentModels } from './agent-model-resolver.js';
import { AbgGraphValidationError, type CompiledAbgRule, compileAbgRule } from './rule-compiler.js';

export type AuthorableAbgGraph = AbgGraphSpec & {
    readonly compiledRules: readonly CompiledAbgRule[];
};

export function createAuthorableAbgGraph(
    input: unknown,
    agentModelLookup?: AgentModelLookup,
): AuthorableAbgGraph {
    const parsed = AbgGraphSpecSchema.safeParse(input);
    if (!parsed.success) {
        throw new AbgGraphValidationError('invalid ABG graph spec', parsed.error.issues.length);
    }
    assertRuleReferences(parsed.data);
    const resolved =
        agentModelLookup !== undefined
            ? resolveGraphAgentModels(parsed.data, agentModelLookup)
            : parsed.data;
    const graph = {
        ...resolved,
        nodes: resolved.nodes.map((node) => ({ ...node })),
        edges: resolved.edges.map((edge) => ({ ...edge })),
        rules: resolved.rules.map((rule) => ({ ...rule })),
        policies: resolved.policies.map((policy) => ({ ...policy })),
        compiledRules: resolved.rules.map((rule) => compileAbgRule(rule)),
    } satisfies AuthorableAbgGraph;
    freezeDeep(graph);
    return graph;
}

export function resolveAbgNodeModel(graph: AuthorableAbgGraph, nodeId: string): AbgNodeModelOptions | undefined {
    const node = findNode(graph.nodes, nodeId);
    if (node === undefined) {
        throw new AbgGraphValidationError(`unknown ABG node: ${nodeId}`, 1);
    }
    return node.model ?? graph.defaults?.model;
}

function assertRuleReferences(graph: AbgGraphSpec): void {
    const ruleIds = new Set(graph.rules.map((rule) => rule.id));
    for (const node of graph.nodes) {
        for (const ruleId of node.rules ?? []) {
            if (!ruleIds.has(ruleId)) {
                throw new AbgGraphValidationError(`unknown ABG node rule: ${ruleId}`, 1);
            }
        }
    }
    for (const edge of graph.edges) {
        if (edge.condition !== undefined && !ruleIds.has(edge.condition)) {
            throw new AbgGraphValidationError(`unknown ABG edge condition rule: ${edge.condition}`, 1);
        }
    }
}

function findNode(nodes: readonly AbgNodeSpec[], nodeId: string): AbgNodeSpec | undefined {
    return nodes.find((node) => node.id === nodeId);
}

function freezeDeep(value: unknown): void {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return;
    }
    for (const child of Object.values(value)) {
        freezeDeep(child);
    }
    Object.freeze(value);
}
