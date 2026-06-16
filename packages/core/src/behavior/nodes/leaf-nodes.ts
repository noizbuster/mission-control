import type { AbgNodeSpec, AbgPolicySpec, AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry.js';

export function createLeafNodeRunners(): readonly (readonly [string, AbgNodeRunner])[] {
    return [
        ['condition', runConditionNode],
        ['action', runActionNode],
        ['llm', runLlmNode],
        ['tool', runToolNode],
        ['memory', runMemoryNode],
        ['policy', runPolicyNode],
        ['human-approval', runHumanApprovalNode],
        ['actor', runActorNode],
    ];
}

async function* runConditionNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    if (readBooleanConfig(node, 'pass') === false) {
        yield failure(node, context, { code: 'condition_failed' });
        return;
    }
    yield success(node, context, { passed: true });
}

async function* runActionNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    yield progress(node, context, 'mock action executed');
    yield success(node, context, { action: node.implementation ?? node.kind });
}

async function* runLlmNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    const model = node.model ?? context.model;
    yield started(node, context);
    yield progress(node, context, 'mock llm model selected', {
        model,
    });
    yield success(node, context, {
        output: 'mock llm output',
        model,
    });
}

async function* runToolNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    yield emit(node, context, 'tool.proposed', {
        capabilities: node.capabilities ?? [],
    });
    yield success(node, context, { tool: node.implementation ?? node.kind });
}

async function* runMemoryNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    yield success(node, context, {
        items: [],
    });
}

async function* runPolicyNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    const blocked = findBlockingPolicy(node, context.policies ?? []);
    if (blocked !== undefined) {
        yield emit(node, context, 'policy.blocked', {
            capability: blocked.capability,
            decision: blocked.decision,
            reason: blocked.reason,
        });
        yield failure(node, context, {
            code: 'policy_blocked',
            capability: blocked.capability,
            decision: blocked.decision,
        });
        return;
    }
    yield success(node, context, { decision: 'allow' });
}

async function* runHumanApprovalNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    yield progress(node, context, `waiting for human approval: ${node.id}`);
    yield failure(node, context, {
        code: 'human_approval_required',
    });
}

async function* runActorNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    const actor = readStringConfig(node, 'actor') ?? node.id;
    yield started(node, context);
    yield {
        type: 'spawn',
        graphId: context.graphId,
        nodeId: node.id,
        actor,
        input: context.input,
    };
    yield success(node, context, { actor });
}

function started(node: AbgNodeSpec, context: AbgNodeRunContext): AbgSignal {
    return {
        type: 'started',
        graphId: context.graphId,
        nodeId: node.id,
    };
}

function progress(node: AbgNodeSpec, context: AbgNodeRunContext, message: string, data?: unknown): AbgSignal {
    return {
        type: 'progress',
        graphId: context.graphId,
        nodeId: node.id,
        message,
        ...(data !== undefined ? { data } : {}),
    };
}

function success(node: AbgNodeSpec, context: AbgNodeRunContext, result?: unknown): AbgSignal {
    return {
        type: 'success',
        graphId: context.graphId,
        nodeId: node.id,
        ...(result !== undefined ? { result } : {}),
    };
}

function failure(node: AbgNodeSpec, context: AbgNodeRunContext, error: unknown): AbgSignal {
    return {
        type: 'failure',
        graphId: context.graphId,
        nodeId: node.id,
        error,
    };
}

function emit(node: AbgNodeSpec, context: AbgNodeRunContext, eventType: string, payload: unknown): AbgSignal {
    return createAbgEmitSignal({
        graphId: context.graphId,
        nodeId: node.id,
        eventType,
        timestamp: context.now(),
        payload,
    });
}

function findBlockingPolicy(node: AbgNodeSpec, policies: readonly AbgPolicySpec[]): AbgPolicySpec | undefined {
    const capabilities = node.capabilities ?? [];
    return policies.find((policy) => capabilities.includes(policy.capability) && policy.decision !== 'allow');
}

function readBooleanConfig(node: AbgNodeSpec, key: string): boolean | undefined {
    const value = node.config?.[key];
    return typeof value === 'boolean' ? value : undefined;
}

function readStringConfig(node: AbgNodeSpec, key: string): string | undefined {
    const value = node.config?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export type { AbgNodeRunner };
