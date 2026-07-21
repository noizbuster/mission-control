/**
 * Public API for agent discovery, parsing, and registry.
 *
 * `AgentDefinition` is re-exported from `@mission-control/protocol` so consumers
 * of `@mission-control/core` can import the agent type surface from one place.
 */

export type { AgentDefinition } from '@mission-control/protocol';
export type {
    AgentJobRecoveryReport,
    ResolveSubagentWaitInput,
    StartSubagentWaitInput,
} from './agent-job-sql-mirror';
export type { AgentDiscoveryDiagnostic, DiscoverAgentsOptions, DiscoverAgentsResult } from './agent-loader';
export { discoverAgents } from './agent-loader';
export { AgentParseError, parseAgentFile } from './agent-parser';
export { AgentIndex } from './agent-registry';
export {
    AsyncJobCleanupError,
    AsyncJobManager,
    type BackgroundJobHandle,
    type JobExecuteFn,
    type StartJobInput,
} from './async-job-manager';
export { BUNDLED_AGENT_TEMPLATES } from './bundled/index';
export {
    CHILD_HARD_DROPPED_CAPABILITY_KINDS,
    CHILD_NETWORK_ALLOWED_CATEGORIES,
    hasHardDroppedCapability,
    isChildNetworkCategoryAllowed,
    type HardDropOptions,
} from './child-graph-spawn';
export {
    type AgentDisposer,
    AgentLifecycleManager,
    type AgentReviver,
    type LifecycleAdoptOptions,
    type PersistedSubagentReviverFactory,
} from './lifecycle-manager';
export type { ModelPattern } from './model-resolver';
export {
    type AdoptOptions,
    type AgentKind,
    type AgentRef,
    type AgentRefInput,
    type AgentStatus,
    type AgentUpdatePatch,
    getRuntimeRegistry,
    MAIN_AGENT_ID,
    type RuntimeAgentPersistenceMirror,
    RuntimeAgentRegistry,
    type RuntimeAgentRegistryOptions,
} from './runtime-registry';
export {
    DEFAULT_STALL_THRESHOLD_MS,
    findStalledTargets,
    formatSilentDuration,
    isSilentLongerThan,
    type StallDetectionInput,
    type StalledAgentTarget,
    type StalledJobTarget,
    type StalledMainTurnTarget,
    type StalledTarget,
} from './stall-detection';
export {
    createSqlTaskRuntimeServices,
    type SqlTaskRuntimeServices,
    type SqlTaskRuntimeServicesOptions,
} from './sql-task-runtime-services';
export {
    canSpawnAtDepth,
    DEFAULT_MAX_RECURSION_DEPTH,
    HARD_RECURSION_CAP,
    PRODUCTION_MAX_TASK_DEPTH,
    RecursionTracker,
} from './recursion-policy';
export {
    type ChildSpawnContext,
    ConcreteTaskToolRuntime,
    type ConcreteTaskToolRuntimeOptions,
    type ResolveAgentModelFn,
    type SpawnFn,
    type TaskToolRuntimeServices,
    type TaskToolSubagentMirror,
} from './task-tool-runtime';
