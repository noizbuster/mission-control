import type { ProviderAuthStore } from '@mission-control/core';
import type { AgentEvent, AgentSnapshot, ModelProviderSelection } from '@mission-control/protocol';
import type { QuestionBatchEntry, QuestionOption } from '../chat.js';
import type { AbgOverlayController } from './abg-overlay-controller.js';
import type { ApprovalLevel } from './approval-level.js';
import type { ChatAppActions } from './chat-app-actions.js';
import type { ChatInputEvent } from './chat-input-event.js';
import type {
    DashboardAgentEntry,
    HistoryPickerEntry,
    MissionPanelRow,
    SessionPickerEntry,
} from './chat-store.js';
import type { ModelChoice } from './interactive-chat-model.js';
import type { MissionControlServicesLike } from './mission-services-types.js';
import type { ModelsOverlayRoleRow } from './models-overlay-state.js';
import type { WelcomeData } from './welcome-data-types.js';

/** Public surface consumed by the imperative chat loop. */
export type ChatTuiHandle = {
    readonly waitForEvent: () => Promise<ChatInputEvent>;
    readonly emitOutput: (text: string) => void;
    readonly replaceOutputText: (text: string) => void;
    readonly getOutput: () => string;
    readonly showModelPicker: (choices: readonly ModelChoice[]) => Promise<ModelProviderSelection | undefined>;
    readonly showSessionPicker: (entries: readonly SessionPickerEntry[]) => Promise<string | undefined>;
    readonly showAgentsDashboard: (entries: readonly DashboardAgentEntry[]) => void;
    readonly reloadAgentsDashboard: (entries: readonly DashboardAgentEntry[]) => void;
    readonly hideAgentsDashboard: () => void;
    readonly showMissionPanel: (rows?: readonly MissionPanelRow[]) => void;
    readonly reloadMissions: (rows: readonly MissionPanelRow[]) => void;
    readonly hideMissionPanel: () => void;
    readonly showModelsOverlay: (
        entries: readonly ModelProviderSelection[],
        roleRows: readonly ModelsOverlayRoleRow[],
    ) => void;
    readonly showLevelPicker: (currentLevel?: string) => Promise<string | undefined>;
    readonly setApprovalLevel: (level: ApprovalLevel | undefined) => void;
    readonly setSessionId: (sessionId: string) => void;
    readonly setSessionDisplayName: (name: string | undefined) => void;
    readonly setContextTokensUsed: (used: number | undefined) => void;
    readonly setModelCycleChoices: (choices: readonly ModelChoice[]) => void;
    /** Push a selection from any path; syncs the store's currentModelSelection and modelCycleIndex. */
    readonly setModelSelection: (selection: ModelProviderSelection) => void;
    onModelCycleSelect: ((selection: ModelProviderSelection) => void) | undefined;
    onRenameSubmit: ((name: string) => void) | undefined;
    readonly setGenerating: (value: boolean) => void;
    readonly setWorkflowNames: (names: readonly string[]) => void;
    readonly setAgentStatus: (text: string) => void;
    readonly clearAgentStatus: () => void;
    readonly showTransientNotice: (message: string) => void;
    readonly isShowThinking: () => boolean;
    readonly isToolOutputExpanded: () => boolean;
    readonly showApproval: (toolName: string, action: string) => void;
    readonly hideApproval: () => void;
    readonly showQuestion: (
        question: string,
        options: readonly (string | QuestionOption)[],
        metadata?: { readonly header?: string; readonly multiple?: boolean },
    ) => Promise<string>;
    /** Multi-question batch as one tabbed overlay (opencode-style). Resolves
     * with one answer string per entry, in order. */
    readonly showQuestionBatch: (entries: readonly QuestionBatchEntry[]) => Promise<string[]>;
    readonly applyAbgOverlayPrefs: (prefs: {
        readonly activeTabIndex: number;
        readonly scrollOffset: number;
        readonly liveOutput: boolean;
        readonly showThinking: boolean;
        readonly toolOutputExpanded: boolean;
    }) => void;
    readonly getAbgOverlayPrefsSnapshot: () => {
        readonly activeTabIndex: number;
        readonly scrollOffset: number;
        readonly liveOutput: boolean;
        readonly showThinking: boolean;
        readonly toolOutputExpanded: boolean;
    };
    readonly unmount: () => void;
};

export type ChatTuiRuntimeEventSubscriber = (listener: (event: AgentEvent) => void) => () => void;
export type ChatTuiSessionSnapshotLoader = () => AgentSnapshot | Promise<AgentSnapshot | undefined> | undefined;

/** Provider/model/session info passed through to the StatusBar render surface. */
export type ChatTuiRuntimeOptions = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
    readonly workspaceRoot?: string;
    readonly gitBranch?: string;
    readonly isWorktree?: boolean;
    readonly initialHistoryEntries?: readonly HistoryPickerEntry[];
    readonly initialApprovalLevel?: ApprovalLevel;
    readonly authStore?: ProviderAuthStore;
    readonly abgOverlayController?: AbgOverlayController;
    readonly welcomeData?: WelcomeData;
    readonly missionControlServices?: MissionControlServicesLike;
    readonly subscribeEvents?: ChatTuiRuntimeEventSubscriber;
    readonly loadSessionSnapshot?: ChatTuiSessionSnapshotLoader;
    readonly actions?: ChatAppActions;
};
