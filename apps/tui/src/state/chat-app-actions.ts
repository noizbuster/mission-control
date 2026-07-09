/**
 * Callback interface for CLI-runtime actions that TUI overlays trigger.
 *
 * The concrete implementations (agent config persistence, dashboard/mission
 * data loading) live in the CLI because they bridge to CLI runtime concerns
 * (agent discovery, mission stores). The TUI overlays receive these callbacks
 * via App props, preserving the CLI → TUI dependency direction.
 *
 * `DashboardAgentEntry` and `MissionPanelRow` come from the chat store state
 * (same package). All callbacks are optional; overlays no-op when undefined.
 */
import type { DashboardAgentEntry, MissionPanelRow } from './chat-store.js';

export type ExternalEditorActionResult =
    | { readonly kind: 'updated'; readonly text: string }
    | { readonly kind: 'unavailable'; readonly message: string }
    | { readonly kind: 'failed'; readonly message: string };

export type TerminalSuspendActionResult =
    | { readonly kind: 'suspended' }
    | { readonly kind: 'unsupported'; readonly message: string };

export type ChatAppActions = {
    readonly loadDashboardAgentEntries?: (
        workspaceRoot: string,
        userConfigDir: string,
    ) => Promise<readonly DashboardAgentEntry[]>;
    readonly loadMissionPanelRows?: (workspaceRoot: string | undefined) => Promise<readonly MissionPanelRow[]>;
    readonly toggleAgentDisabled?: (workspaceRoot: string, name: string, action: 'add' | 'remove') => Promise<void>;
    readonly setAgentModelOverride?: (workspaceRoot: string, name: string, value: string | undefined) => Promise<void>;
    /** Returns true when `raw` is a valid `provider/model[#variant]` pattern. */
    readonly isValidModelPattern?: (raw: string) => boolean;
    readonly openExternalEditor?: (initialText: string) => Promise<ExternalEditorActionResult>;
    readonly suspendTerminal?: () => TerminalSuspendActionResult;
};
