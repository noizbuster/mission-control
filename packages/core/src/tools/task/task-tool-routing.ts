import type { PolicyEffectRule } from '@mission-control/protocol';
import type { SessionControlEpoch } from '../../runtime/session-control-cancellation';
import { ToolExecutionError } from '../tool-registry-types';
import { type CategoryDefinition, getCategory } from './category-catalog';
import type { BatchTaskItem, ChildSpawnRequest, TaskToolParams } from './task-tool-contract';

const NESTED_SUBAGENT_DENY_RULE: PolicyEffectRule = {
    action: 'subagent',
    resource: '**',
    effect: 'deny',
};

export type RoutingResolution = {
    readonly category?: CategoryDefinition;
    readonly subagentType?: string;
};

export function resolveRoutingFromAgent(agent: string): RoutingResolution {
    const matched = getCategory(agent);
    return matched !== undefined ? { category: matched, subagentType: agent } : { subagentType: agent };
}

export function resolveRouting(params: TaskToolParams): RoutingResolution {
    if (params.category !== undefined) {
        const category = getCategory(params.category);
        if (category === undefined) {
            throw new ToolExecutionError({
                code: 'schema_invalid',
                message: `unknown category: ${params.category}`,
                retryable: true,
            });
        }
        return { category };
    }
    if (params.subagent_type !== undefined) return resolveRoutingFromAgent(params.subagent_type);
    if (params.agent !== undefined) return resolveRoutingFromAgent(params.agent);
    const fallback = getCategory('deep');
    return fallback !== undefined ? { category: fallback } : {};
}

export function buildChildPermissions(category: CategoryDefinition | undefined): readonly PolicyEffectRule[] {
    return [...(category?.permissions ?? []), NESTED_SUBAGENT_DENY_RULE];
}

export function buildRequest(input: {
    readonly params: TaskToolParams;
    readonly routing: RoutingResolution;
    readonly sessionId: string;
    readonly childPermissions: readonly PolicyEffectRule[];
    readonly parentContext?: string;
    readonly signal?: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
}): ChildSpawnRequest {
    return {
        sessionId: input.sessionId,
        prompt: input.params.prompt ?? input.params.assignment ?? '',
        loadSkills: input.params.load_skills,
        childPermissions: input.childPermissions,
        ...(input.routing.category !== undefined ? { category: input.routing.category } : {}),
        ...(input.routing.subagentType !== undefined ? { subagentType: input.routing.subagentType } : {}),
        ...(input.parentContext !== undefined ? { parentContext: input.parentContext } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
    };
}

export function buildBatchRequest(input: {
    readonly item: BatchTaskItem;
    readonly sessionId: string;
    readonly childPermissions: readonly PolicyEffectRule[];
    readonly parentContext: string | undefined;
    readonly signal: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
}): ChildSpawnRequest {
    const routing = resolveRoutingFromAgent(input.item.agent);
    return {
        sessionId: input.sessionId,
        prompt: input.item.assignment,
        loadSkills: [],
        childPermissions: input.childPermissions,
        ...(routing.category !== undefined ? { category: routing.category } : {}),
        ...(routing.subagentType !== undefined ? { subagentType: routing.subagentType } : {}),
        ...(input.parentContext !== undefined ? { parentContext: input.parentContext } : {}),
        signal: input.signal,
        ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
    };
}
