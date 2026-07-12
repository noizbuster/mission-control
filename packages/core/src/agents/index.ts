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
} from './agent-job-sql-mirror.js';
export type { AgentDiscoveryDiagnostic, DiscoverAgentsOptions, DiscoverAgentsResult } from './agent-loader.js';
export { discoverAgents } from './agent-loader.js';
export { AgentParseError, parseAgentFile } from './agent-parser.js';
export { AgentIndex } from './agent-registry.js';
export {
    AsyncJobManager,
    type BackgroundJobHandle,
    type JobExecuteFn,
    type StartJobInput,
} from './async-job-manager.js';
export { BUNDLED_AGENT_TEMPLATES } from './bundled/index.js';
export {
    type AgentDisposer,
    AgentLifecycleManager,
    type AgentReviver,
    type LifecycleAdoptOptions,
    type PersistedSubagentReviverFactory,
} from './lifecycle-manager.js';
export type { ModelPattern } from './model-resolver.js';
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
} from './runtime-registry.js';
export {
    createSqlTaskRuntimeServices,
    type SqlTaskRuntimeServices,
    type SqlTaskRuntimeServicesOptions,
} from './sql-task-runtime-services.js';
export {
    type ChildSpawnContext,
    ConcreteTaskToolRuntime,
    type ConcreteTaskToolRuntimeOptions,
    type ResolveAgentModelFn,
    type SpawnFn,
    type TaskToolRuntimeServices,
    type TaskToolSubagentMirror,
} from './task-tool-runtime.js';
