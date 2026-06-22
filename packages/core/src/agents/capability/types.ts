import type { AgentDefinition } from '@mission-control/protocol';

/**
 * Context handed to every provider's {@linkcode AgentPluginProvider.loadAgents} call.
 * The registry performs no I/O itself; each provider scans its own scopes using
 * these two roots.
 */
export interface LoadContext {
    readonly workspaceRoot: string;
    readonly userConfigDir: string;
}

/**
 * A pluggable agent source. Each provider owns its own I/O — directory walks, file
 * reads, harness-format imports — inside {@linkcode loadAgents}. The registry sorts
 * providers by descending priority, invokes each, and deduplicates results by agent
 * name (first-seen wins).
 *
 * Priority guide:
 *   100+ : mission-control's own providers (builtin 4-scope loader)
 *   50-99: standard cross-harness importers (Claude, Cursor, Codex, ...)
 *   1-49 : legacy / experimental providers
 */
export interface AgentPluginProvider {
    /** Unique provider identifier (e.g. "builtin", "claude", "cursor"). */
    readonly id: string;
    /** Human-readable label surfaced in diagnostics and UI. */
    readonly displayName: string;
    /** Short description of what the provider imports. */
    readonly description: string;
    /** Higher priority wins on agent-name conflicts. */
    readonly priority: number;
    loadAgents(ctx: LoadContext): Promise<readonly AgentDefinition[]>;
}
