/**
 * Default child-graph spawn fn + hard capability filtering for
 * {@linkcode ConcreteTaskToolRuntime}.
 *
 * Extracted from `task-tool-runtime.ts` to keep both modules under the 250 pure-LOC
 * ceiling. The spawn fn consumes the fully-resolved {@linkcode ChildSpawnContext}
 * (agent, model, systemPrompt, child tool surface) and runs a bounded coding-agent
 * graph via `spawnChildCodingAgent`. The hard-drop constant lives here too because it
 * is the registry-layer guard that backs the spawn safety contract.
 */
import type { AbgNodeModelOptions } from '@mission-control/protocol';
import { spawnChildCodingAgent } from '../behavior/subagents/spawn-child.js';
import type { SdkModelResolver } from '../providers/ai-sdk/model-resolver.js';
import type { ChildSpawnResult } from '../tools/task/task-tool.js';
import { createYieldToolRegistration } from '../tools/yield-tool/yield-tool.js';
import type { ChildSpawnContext } from './task-tool-runtime.js';

/**
 * Capability classes ALWAYS dropped from child tool surfaces, regardless of path
 * policies. `subagent` (nested task recursion — ABG §10.6), `workflow` (self-invokable
 * workflow graph recursion), and `network` (webfetch/mcp reaching beyond the
 * workspace). Destructive kinds (bash/write/patch) are intentionally excluded — they
 * are policy-controlled via `deriveChildPathPolicies` so a `deep` agent keeps
 * write/bash while a `planner` loses them.
 */
const CHILD_HARD_DROPPED_CAPABILITY_KINDS: readonly string[] = ['subagent', 'workflow', 'network'];

export function hasHardDroppedCapability(capabilities: readonly string[]): boolean {
    return capabilities.some((capability) =>
        CHILD_HARD_DROPPED_CAPABILITY_KINDS.some((kind) => capability.includes(kind)),
    );
}

export interface ChildGraphSpawnDeps {
    readonly resolveSdkModel: SdkModelResolver;
    readonly summaryLimit?: number;
}

export function defaultSpawnFn(context: ChildSpawnContext): Promise<ChildSpawnResult> {
    void context;
    return Promise.reject(new Error('spawnFn not wired: provide resolveSdkModel or an explicit spawnFn'));
}

/**
 * Build the default spawn fn: runs a bounded child coding-agent graph from the
 * resolved context. The child gets its OWN identity (agent body via `systemPrompt`),
 * the pre-built child tool surface (yield present, task absent), and yolo approval
 * semantics (the parent's `task()` call is the authorization boundary). The yielded
 * result (captured via the `onYield` callback) becomes the child's `output`; if the
 * child never calls `yield`, the last assistant text is the fallback.
 */
export function createChildGraphSpawnFn(deps: ChildGraphSpawnDeps): (context: ChildSpawnContext) => Promise<ChildSpawnResult> {
    return async (context) => {
        let yieldedResult: { readonly value: unknown } | undefined;

        // Replace yield by name (register overwrites) so the submitted result is captured.
        context.childToolRegistry.register(
            createYieldToolRegistration({
                onYield: (result) => {
                    yieldedResult = { value: result };
                },
            }),
        );

        const modelOptions: AbgNodeModelOptions = {
            providerID: context.model.providerID,
            modelID: context.model.modelID,
            ...(context.model.variantID !== undefined ? { variantID: context.model.variantID } : {}),
        };

        const taskOutput = await spawnChildCodingAgent({
            description: context.agent.name,
            prompt: context.prompt,
            resolveSdkModel: deps.resolveSdkModel,
            model: modelOptions,
            parentToolRegistry: context.childToolRegistry,
            childToolRegistry: context.childToolRegistry,
            systemPrompt: context.systemPrompt,
            now: () => new Date().toISOString(),
            sessionId: context.sessionId,
            ...(deps.summaryLimit !== undefined ? { summaryLimit: deps.summaryLimit } : {}),
        });

        const output =
            yieldedResult !== undefined ? stringifyYieldResult(yieldedResult.value) : taskOutput.summary;
        return { sessionId: context.sessionId, status: taskOutput.status, output };
    };
}

function stringifyYieldResult(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
