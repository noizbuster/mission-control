import type { PermissionSession, Skill, TaskToolRuntimeServices, WorkflowRegistry } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type {
    AbgOverlayController,
    ApprovalLevel,
    DashboardAgentEntry,
    MissionPanelRow,
    ModelsOverlayRoleRow,
    SessionPickerEntry,
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
    readonly sessionNavigation?: SessionNavigationController;
    readonly skills?: readonly Skill[];
    readonly workflowRegistry?: WorkflowRegistry;
    readonly plainPromptGraph?: PlainPromptGraph;
    readonly sessionDisplayName?: SessionDisplayNameController;
    readonly onSessionRenamed?: (name: string) => Promise<void>;
    readonly undoRedo?: UndoRedoConversationController;
    readonly selectApprovalLevel?: (currentLevel?: ApprovalLevel) => Promise<ApprovalLevel | undefined>;
    readonly listWorkspaceSessions?: () => Promise<readonly SessionPickerEntry[]>;
    readonly selectSessionForAttach?: (entries: readonly SessionPickerEntry[]) => Promise<string | undefined>;
    readonly openAgentsDashboard?: (entries: readonly DashboardAgentEntry[]) => void;
    readonly reloadAgentsDashboard?: (entries: readonly DashboardAgentEntry[]) => void;
    readonly openMissionPanel?: (rows: readonly MissionPanelRow[]) => void;
    readonly reloadMissionPanel?: (rows: readonly MissionPanelRow[]) => void;
    readonly openModelsOverlay?: (
        entries: readonly ModelProviderSelection[],
        roleRows: readonly ModelsOverlayRoleRow[],
    ) => void;
    readonly authStore?: ProviderAuthStore;
    readonly permissionSession?: PermissionSession;
    readonly taskRuntimeServices?: TaskToolRuntimeServices;
    readonly abgOverlayController?: AbgOverlayController;
};
