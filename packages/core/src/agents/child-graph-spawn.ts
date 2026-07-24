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
import type { AbgNodeModelOptions, ProtocolError } from '@mission-control/protocol';
import { spawnChildCodingAgent } from '../behavior/subagents/spawn-child';
import type { SdkModelResolver } from '../providers/ai-sdk/model-resolver';
import { createObservabilityRedactor } from '../providers/observability-redactor';
import type { ChildSpawnResult } from '../tools/task/task-tool';
import { createYieldToolRegistration } from '../tools/yield-tool/yield-tool';
import type { ChildSpawnContext } from './task-tool-runtime';

/**
 * Capability classes hard-dropped from child tool surfaces by default.
 * - `subagent`: nested task recursion (omitted when nesting is depth-allowed —
 *   see {@linkcode hasHardDroppedCapability} `allowSubagentNesting`)
 * - `workflow`: self-invokable workflow graph recursion (always dropped)
 * - `network`: webfetch/web_search/mcp beyond the workspace (default dropped;
 *   omitted only when the resolved category id or agent name is in
 *   {@linkcode CHILD_NETWORK_ALLOWED_CATEGORIES} via `allowNetworkCapability`)
 * - `team`: child-created orchestration groups (always dropped)
 * Destructive kinds (bash/write/patch) stay policy-controlled via path policies.
 * Do not remove `network` from this set globally — the allowlist is a filter-time exception.
 */
export const CHILD_HARD_DROPPED_CAPABILITY_KINDS: ReadonlySet<string> = new Set([
    'subagent',
    'workflow',
    'network',
    'team',
]);

/**
 * Categories (and same-named bundled agents) that may retain `network` tools on
 * the child surface when the parent already advertises them. OFF categories
 * (explore, reviewer, quick) stay hard-dropped for network.
 */
export const CHILD_NETWORK_ALLOWED_CATEGORIES: ReadonlySet<string> = new Set([
    'architect',
    'librarian',
    'deep',
    'reasoner',
    'oracle',
    'designer',
    'planner',
]);

const DEFAULT_CHILD_SUMMARY_LIMIT = 4000;
/** Prefix on salvage text when the child never called `yield`. Exported for settlement classifiers. */
export const DEGRADED_SALVAGE_LABEL = '[degraded salvage] ';

export type HardDropOptions = {
    /** When true, do not hard-drop `subagent` solely to block nesting (todo 1c). */
    readonly allowSubagentNesting?: boolean;
    /**
     * When true, do not hard-drop `network` solely for the category allowlist (todo 1b).
     * Independent of {@linkcode allowSubagentNesting}.
     */
    readonly allowNetworkCapability?: boolean;
};

export function isChildNetworkCategoryAllowed(categoryOrAgentName: string): boolean {
    return CHILD_NETWORK_ALLOWED_CATEGORIES.has(categoryOrAgentName);
}

export function hasHardDroppedCapability(capabilities: readonly string[], options?: HardDropOptions): boolean {
    return (
        hasAlwaysDroppedCapability(capabilities) ||
        hasSubagentDroppedCapability(capabilities, options?.allowSubagentNesting === true) ||
        hasNetworkDroppedCapability(capabilities, options?.allowNetworkCapability === true)
    );
}

function hasAlwaysDroppedCapability(capabilities: readonly string[]): boolean {
    return capabilities.some((capability) => capability === 'workflow' || capability === 'team');
}

function hasSubagentDroppedCapability(capabilities: readonly string[], allowSubagentNesting: boolean): boolean {
    return !allowSubagentNesting && capabilities.includes('subagent');
}

function hasNetworkDroppedCapability(capabilities: readonly string[], allowNetworkCapability: boolean): boolean {
    return !allowNetworkCapability && capabilities.includes('network');
}

export interface ChildGraphSpawnDeps {
    readonly resolveSdkModel: SdkModelResolver;
    readonly summaryLimit?: number;
}

export class MissingChildSpawnConfigurationError extends Error {
    constructor() {
        super('spawnFn not wired: provide resolveSdkModel or an explicit spawnFn');
        this.name = 'MissingChildSpawnConfigurationError';
    }
}

export const MISSING_CHILD_SPAWN_CONFIGURATION_FAILURE: ProtocolError = {
    code: 'tool_failed',
    message: 'Child spawning is not configured',
    retryable: false,
};

export function defaultSpawnFn(): Promise<ChildSpawnResult> {
    return Promise.reject(new MissingChildSpawnConfigurationError());
}

/**
 * Build the default spawn fn. Only an explicit `yield` result is a completed
 * child task; a graph that ends without one is a failed, bounded salvage result.
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
        const failure = taskOutput.failure;
        if (yieldedResult !== undefined) {
            return {
                sessionId: context.sessionId,
                status: taskOutput.status,
                output: observabilityRedactor.redactText(stringifyYieldResult(yieldedResult.value)),
                ...(taskOutput.status === 'failed' ? { failureKind: 'graph_failed' as const } : {}),
                ...(failure !== undefined ? { failure } : {}),
            };
        }

        const salvage = boundedDegradedSalvage(
            observabilityRedactor.redactText(taskOutput.summary),
            deps.summaryLimit ?? DEFAULT_CHILD_SUMMARY_LIMIT,
        );
        const failureKind = taskOutput.status === 'failed' ? ('graph_failed' as const) : ('yield_missing' as const);
        return {
            sessionId: context.sessionId,
            status: 'failed',
            output: observabilityRedactor.redactText(salvage),
            failureKind,
            ...(failure !== undefined ? { failure } : {}),
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
