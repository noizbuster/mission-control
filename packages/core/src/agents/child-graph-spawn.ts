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
import { createObservabilityRedactor } from '../providers/observability-redactor.js';
import type { ChildSpawnResult } from '../tools/task/task-tool.js';
import { createYieldToolRegistration } from '../tools/yield-tool/yield-tool.js';
import type { ChildSpawnContext } from './task-tool-runtime.js';

/**
 * Capability classes ALWAYS dropped from child tool surfaces, regardless of path
 * policies. `subagent` (nested task recursion — ABG §10.6), `workflow` (self-invokable
 * workflow graph recursion), `network` (webfetch/mcp reaching beyond the workspace),
 * and `team` (child-created orchestration groups). Destructive kinds
 * (bash/write/patch) are intentionally excluded — they
 * are policy-controlled via `deriveChildPathPolicies` so a `deep` agent keeps
 * write/bash while a `planner` loses them.
 */
const CHILD_HARD_DROPPED_CAPABILITY_KINDS = new Set<string>(['subagent', 'workflow', 'network', 'team']);
const DEFAULT_CHILD_SUMMARY_LIMIT = 4000;
const DEGRADED_SALVAGE_LABEL = '[degraded salvage] ';

export function hasHardDroppedCapability(capabilities: readonly string[]): boolean {
    return capabilities.some((capability) => CHILD_HARD_DROPPED_CAPABILITY_KINDS.has(capability));
}

export interface ChildGraphSpawnDeps {
    readonly resolveSdkModel: SdkModelResolver;
    readonly summaryLimit?: number;
}

export function defaultSpawnFn(): Promise<ChildSpawnResult> {
    return Promise.reject(new Error('spawnFn not wired: provide resolveSdkModel or an explicit spawnFn'));
}

/**
 * Build the default spawn fn: runs a bounded child coding-agent graph from the
 * resolved context. The child gets its OWN identity (agent body via `systemPrompt`),
 * the pre-built child tool surface (yield present, task absent). Cloned effectful tools
 * retain their original permission callbacks, while the child invocation policy enforces
 * derived path rules. The yielded
 * result (captured via the `onYield` callback) becomes the child's `output`; if the
 * child never calls `yield`, a bounded degraded salvage summary is returned with failed status.
 */
export function createChildGraphSpawnFn(
    deps: ChildGraphSpawnDeps,
): (context: ChildSpawnContext) => Promise<ChildSpawnResult> {
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
            childToolRegistry: context.childToolRegistry,
            systemPrompt: context.systemPrompt,
            now: () => new Date().toISOString(),
            sessionId: context.sessionId,
            signal: context.signal,
            ...(context.controlEpoch !== undefined ? { controlEpoch: context.controlEpoch } : {}),
            ...(deps.summaryLimit !== undefined ? { summaryLimit: deps.summaryLimit } : {}),
            ...(context.hostCallbacks !== undefined ? { hostCallbacks: context.hostCallbacks } : {}),
        });

        const observabilityRedactor = context.hostCallbacks?.observabilityRedactor ?? createObservabilityRedactor();
        const rawOutput =
            yieldedResult === undefined
                ? boundedDegradedSalvage(
                      observabilityRedactor.redactText(taskOutput.summary),
                      deps.summaryLimit ?? DEFAULT_CHILD_SUMMARY_LIMIT,
                  )
                : stringifyYieldResult(yieldedResult.value);
        return {
            sessionId: context.sessionId,
            status: yieldedResult === undefined ? 'failed' : taskOutput.status,
            output: observabilityRedactor.redactText(rawOutput),
        };
    };
}

function boundedDegradedSalvage(summary: string, limit: number): string {
    return `${DEGRADED_SALVAGE_LABEL}${summary}`.slice(0, Math.max(0, limit));
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
