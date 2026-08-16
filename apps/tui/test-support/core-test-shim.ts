// Test-only seam: in test mode apps/tui/vite.config.ts aliases `@mission-control/core` to this
// file so TUI tests exercise core from source without a built dist. The alias makes a
// package-name import from here self-referential (it would resolve back to this file), and
// importing the public barrel source instead transitively loads drizzle-orm/libsql, whose
// native `import { WebSocket } from 'ws'` fails under this suite's externals — so the shim
// binds to the defining modules directly. Every symbol below IS on the public
// `@mission-control/core` surface (see packages/core/src/index.ts); nothing here is private
// core internals.
export {
    type AbgOverlayDraft,
    type AbgOverlayEdge,
    type AbgOverlayState,
    type AbgOverlayStore,
    createAbgOverlayStore,
    DEFAULT_REFRESH_MS,
    extractBlackboardMutation,
    extractBudgetPayload,
    extractUsageFromModelCallCompleted,
    type GraphSummary,
    mergeGraphSnapshot,
    projectAbgSignal,
    projectAgentEvent,
    RECENT_EVENTS_CAP,
    type RecentEvent,
    type RunState,
    readRefreshMsFromEnv,
    redactForDisplay,
} from '../../../packages/core/src/abg-overlay/state';
export { AsyncJobManager, type BackgroundJobHandle } from '../../../packages/core/src/agents/async-job-manager';
export {
    type AgentRef,
    MAIN_AGENT_ID,
    RuntimeAgentRegistry,
} from '../../../packages/core/src/agents/runtime-registry';
export { resolveMissionControlDataDir } from '../../../packages/core/src/memory/data-dir';
export { atomicWriteJsonFile, atomicWriteTextFile } from '../../../packages/core/src/persistence/atomic-write';
export { readBoulder } from '../../../packages/core/src/persistence/boulder-store';
export {
    type TuiPluginHostApi,
    TuiPluginHostRegistry,
    type TuiPluginSource,
} from '../../../packages/core/src/plugins/tui-plugin-host';
export type { ProviderAuthStore } from '../../../packages/core/src/providers/provider-auth-store';
export { redactCredentialText } from '../../../packages/core/src/providers/redaction-handler';
export {
    ContinuationRuntime,
    type ContinuationState,
} from '../../../packages/core/src/runtime/continuation/continuation-runtime';
export {
    type ApprovalProjection,
    projectSessionReplay,
    type SessionReplayProjection,
    type ToolOutcomeProjection,
} from '../../../packages/core/src/session-replay';
export { resolveUserConfigDir } from '../../../packages/core/src/skills/skill-loader';
export { type ProjectTrustLookup, ProjectTrustStore } from '../../../packages/core/src/trust/project-trust-store';
export * as TuiStores from '../../../packages/core/src/tui-stores/index';
export { errorToString } from '../../../packages/core/src/util/error-to-string';
