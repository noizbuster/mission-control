// allow: SIZE_OK -- thin re-export. Real implementation lives in @mission-control/core
// (packages/core/src/abg-overlay/state.ts) so the desktop app and other consumers can share it.
// CLI-only callers continue to import from this path; the symbols are identical.
export {
    type AbgOverlayDraft,
    type AbgOverlayState,
    type AbgOverlayStore,
    createAbgOverlayStore,
    DEFAULT_REFRESH_MS,
    type GraphSummary,
    type RecentEvent,
    type RunState,
    extractBlackboardMutation,
    extractBudgetPayload,
    extractUsageFromModelCallCompleted,
    mergeGraphSnapshot,
    projectAbgSignal,
    projectAgentEvent,
    RECENT_EVENTS_CAP,
    readRefreshMsFromEnv,
    redactForDisplay,
} from '@mission-control/core';
