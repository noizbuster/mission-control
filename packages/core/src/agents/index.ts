/**
 * Public API for agent discovery, parsing, and registry.
 *
 * `AgentDefinition` is re-exported from `@mission-control/protocol` so consumers
 * of `@mission-control/core` can import the agent type surface from one place.
 */

export type { AgentDefinition } from '@mission-control/protocol';
export type { AgentDiscoveryDiagnostic, DiscoverAgentsOptions, DiscoverAgentsResult } from './agent-loader.js';
export { discoverAgents } from './agent-loader.js';
export { AgentParseError, parseAgentFile } from './agent-parser.js';
export { AgentIndex } from './agent-registry.js';
export { BUNDLED_AGENT_TEMPLATES } from './bundled/index.js';
export {
    type ChildSpawnContext,
    ConcreteTaskToolRuntime,
    type ConcreteTaskToolRuntimeOptions,
    type ResolveAgentModelFn,
    type SpawnFn,
} from './task-tool-runtime.js';
