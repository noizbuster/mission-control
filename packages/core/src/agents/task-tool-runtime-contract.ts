import type { AgentDefinition, PolicyEffectRule } from '@mission-control/protocol';
import type { ChildHostCallbacks } from '../behavior/subagents/spawn-child.js';
import type { SdkModelResolver } from '../providers/ai-sdk/model-resolver.js';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import type { SessionControlHost } from '../runtime/session-control-host.js';
import type { ChildSpawnResult } from '../tools/task/task-tool.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AgentIndex } from './agent-registry.js';
import type { AsyncJobManager } from './async-job-manager.js';
import { createChildGraphSpawnFn, defaultSpawnFn } from './child-graph-spawn.js';
import type { AgentLifecycleManager } from './lifecycle-manager.js';
import type { ModelPattern } from './model-resolver.js';
import type { RuntimeAgentRegistry } from './runtime-registry.js';
import type { TaskToolSubagentMirror } from './task-tool-runtime-types.js';

export type TaskToolRuntimeServices = {
    readonly jobManager: AsyncJobManager;
    readonly lifecycleManager: AgentLifecycleManager;
    readonly runtimeRegistry: RuntimeAgentRegistry;
    readonly mirror?: TaskToolSubagentMirror;
    readonly sessionControlHost?: SessionControlHost;
};

export type ResolveAgentModelFn = (agent: AgentDefinition) => ModelPattern;

export type ChildSpawnContext = {
    readonly sessionId: string;
    readonly prompt: string;
    readonly agent: AgentDefinition;
    readonly model: ModelPattern;
    readonly systemPrompt: string;
    readonly childToolRegistry: ToolRegistry;
    readonly childPermissions: readonly PolicyEffectRule[];
    readonly workspaceRoot: string;
    readonly hostCallbacks?: ChildHostCallbacks;
    readonly signal: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
};

export type SpawnFn = (context: ChildSpawnContext) => Promise<ChildSpawnResult>;

export type ConcreteTaskToolRuntimeOptions = {
    readonly agentIndex: AgentIndex;
    readonly resolveModel: ResolveAgentModelFn;
    readonly workspaceRoot: string;
    readonly parentToolRegistry: ToolRegistry;
    readonly parentAgent: AgentDefinition;
    readonly spawnFn?: SpawnFn;
    readonly services?: TaskToolRuntimeServices;
    readonly parentSessionId?: string;
    readonly resolveSdkModel?: SdkModelResolver;
    readonly summaryLimit?: number;
    readonly hostCallbacks?: ChildHostCallbacks;
};

export function resolveTaskToolSpawnFn(options: ConcreteTaskToolRuntimeOptions): SpawnFn {
    if (options.spawnFn !== undefined) return options.spawnFn;
    if (options.resolveSdkModel !== undefined) {
        return createChildGraphSpawnFn({
            resolveSdkModel: options.resolveSdkModel,
            ...(options.summaryLimit !== undefined ? { summaryLimit: options.summaryLimit } : {}),
        });
    }
    return defaultSpawnFn;
}
