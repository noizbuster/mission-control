import type {
    ContextCacheUsage,
    PermissionSession,
    Skill,
    TaskToolRuntimeServices,
    WorkflowRegistry,
} from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type {
    AbgOverlayController,
    ApprovalLevel,
    DashboardAgentEntry,
    MissionPanelRow,
    ModelsOverlayRoleRow,
    SessionPickerEntry,
    TranscriptPart,
} from '@mission-control/tui/state';
import type { ProviderAuthStore } from '../auth-store';
import type { PlainPromptGraph } from './interactive-chat';
import type { PromptTurnContext } from './interactive-chat-prompt-turn';
import type { SessionDisplayNameController } from './interactive-chat-rename-action';
import type { SessionNavigationController } from './interactive-chat-session-navigation';
import type { UndoRedoConversationController } from './interactive-chat-undo-redo-action';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent';

export type CodingActionContext = PromptTurnContext & {
    readonly activeTurn: ActiveCodingAgentTurn | undefined;
    readonly useTui: boolean;
    /** True after TUI teardown (or non-TUI force-close); nav attach must not commit. */
    readonly isUiClosed?: () => boolean;
    readonly sessionNavigation?: SessionNavigationController;
    readonly skills?: readonly Skill[];
    readonly onSkillsReloaded?: (skills: readonly Skill[]) => void;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly plainPromptGraph?: PlainPromptGraph;
    readonly sessionDisplayName?: SessionDisplayNameController;
    readonly onSessionRenamed?: (name: string) => Promise<void>;
    readonly undoRedo?: UndoRedoConversationController;
    readonly replaceSessionTranscript?: (parts: readonly TranscriptPart[], outputText: string) => void;
    /**
     * Commit a navigated session id (and optional store) BEFORE attach projection
     * applies usage/cache, so a later setSessionId wipe cannot clobber them.
     */
    readonly commitAttachedSession?: (sessionId: string, sessionStore?: PromptTurnContext['sessionStore']) => void;
    /** Live turn / attach usage into CLI lastContextTokensUsed (+ TUI when mounted). */
    readonly onUsage?: (inputTokens: number | undefined) => void;
    /** Live turn / attach cache usage into CLI sessionCacheUsage mirror (+ TUI when mounted). */
    readonly onSessionCacheUsage?: (usage: ContextCacheUsage | undefined) => void;
    /** Incremental live-turn cache deltas. */
    readonly onContextCacheUsage?: (usage: ContextCacheUsage) => void;
    readonly selectApprovalLevel?: (currentLevel?: ApprovalLevel) => Promise<ApprovalLevel | undefined>;
    readonly listWorkspaceSessions?: () => Promise<readonly SessionPickerEntry[]>;
    readonly selectSessionForAttach?: (entries: readonly SessionPickerEntry[]) => Promise<string | undefined>;
    readonly openAgentsDashboard?: (entries: readonly DashboardAgentEntry[]) => void;
    readonly reloadAgentsDashboard?: (entries: readonly DashboardAgentEntry[]) => void;
    readonly openMissionPanel?: (rows: readonly MissionPanelRow[]) => void;
    readonly openModelsOverlay?: (
        entries: readonly ModelProviderSelection[],
        roleRows: readonly ModelsOverlayRoleRow[],
    ) => void;
    readonly authStore?: ProviderAuthStore;
    readonly permissionSession?: PermissionSession;
    readonly taskRuntimeServices?: TaskToolRuntimeServices;
    readonly abgOverlayController?: AbgOverlayController;
};
