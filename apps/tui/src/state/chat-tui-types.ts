import type { ProviderAuthStore } from '@mission-control/core';
import type { AgentEvent, AgentSnapshot, ModelProviderSelection, TuiSkillMenuEntry } from '@mission-control/protocol';
import type { QuestionBatchEntry, QuestionOption } from '../chat';
import type { AbgOverlayController } from './abg-overlay-controller';
import type { ApprovalLevel } from './approval-level';
import type { ChatAppActions } from './chat-app-actions';
import type { ChatInputEvent } from './chat-input-event';
import type {
    ContextCacheUsage,
    DashboardAgentEntry,
    HistoryPickerEntry,
    MissionPanelRow,
    SessionPickerEntry,
} from './chat-store';
import type { ModelChoice } from './interactive-chat-model';
import type { MissionControlServicesLike } from './mission-services-types';
import type { ModelsOverlayRoleRow } from './models-overlay-state';
import type { TranscriptPart } from './transcript-part';
import type { WelcomeData } from './welcome-data-types';

/** Public surface consumed by the imperative chat loop. */
export type ChatTuiHandle = {
    readonly waitForEvent: () => Promise<ChatInputEvent>;
    /** Inject a UI input event into the imperative loop (compact auto-heal, etc.). */
    readonly enqueueEvent: (event: ChatInputEvent) => boolean;
    readonly emitOutput: (text: string) => void;
    readonly emitTranscriptPart: (part: TranscriptPart, fallbackText: string) => void;
    readonly emitTranscriptFallback: (text: string) => void;
    readonly replaceOutputText: (text: string) => void;
    /**
     * Hide the last complete user/assistant exchange from the live VIEW only.
     * Keeps typed transcriptParts aligned with outputText. Durable store untouched.
     */
    readonly undoLastViewExchange: () => 'ok' | 'generating' | 'empty' | 'already' | 'blocked';
    /** Restore the single stashed view exchange (leader+r / /redo). */
    readonly redoLastViewExchange: () => 'ok' | 'generating' | 'empty' | 'blocked';
    readonly replaceTranscript: (parts: readonly TranscriptPart[], outputText: string) => void;
    readonly getOutput: () => string;
    /** Fires after replaceTranscript/replaceOutputText change the live output. */
    readonly subscribeOutput: (listener: (output: string) => void) => () => void;
    readonly showModelPicker: (choices: readonly ModelChoice[]) => Promise<ModelProviderSelection | undefined>;
    readonly showSessionPicker: (entries: readonly SessionPickerEntry[]) => Promise<string | undefined>;
    readonly showAgentsDashboard: (entries: readonly DashboardAgentEntry[]) => void;
    readonly isAgentsDurableBusy: () => boolean;
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
    /** Current store session id (for post-await staleness checks). */
    readonly getSessionId: () => string;
    /** True after closeEventQueue; late UI applies must no-op. */
    readonly isEventQueueClosed: () => boolean;
    readonly setSessionDisplayName: (name: string | undefined) => void;
    readonly setContextTokensUsed: (used: number | undefined) => void;
    readonly setContextTokensMaxFromStep: (max: number | undefined) => void;
    readonly beginContextMaxReseed: () => number;
    readonly shouldApplyContextMaxReseed: (epoch: number) => boolean;
    readonly setContextTokensMax: (max: number | undefined) => void;
    readonly setContextCacheUsage: (usage: ContextCacheUsage | undefined) => void;
    readonly setModelCycleChoices: (choices: readonly ModelChoice[]) => void;
    /** Push a selection from any path; syncs the store's currentModelSelection and modelCycleIndex. */
    readonly setModelSelection: (selection: ModelProviderSelection) => void;
    onModelCycleSelect: ((selection: ModelProviderSelection) => void) | undefined;
    onRenameSubmit: ((name: string) => void) | undefined;
    readonly setGenerating: (value: boolean) => void;
    readonly setWorkflowNames: (names: readonly string[]) => void;
    readonly setSkillEntries: (entries: readonly TuiSkillMenuEntry[]) => void;
    readonly setAgentStatus: (text: string) => void;
    readonly setAgentRetryStatus: (text: string, retryAt: number) => void;
    readonly clearAgentStatus: () => void;
    readonly showTransientNotice: (message: string) => void;
    readonly setStickyNotice: (message: string | null) => void;
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
    /**
     * Optional durable history store shared with CLI (same writeChain instance).
     * When omitted, the provider constructs its own store for hydrate/tests only.
     */
    readonly promptHistoryStore?: {
        readonly listEntries: () => Promise<readonly HistoryPickerEntry[]>;
        readonly listTexts: () => Promise<readonly string[]>;
        readonly appendText: (text: string) => Promise<HistoryPickerEntry | undefined>;
    };
    readonly initialApprovalLevel?: ApprovalLevel;
    readonly authStore?: ProviderAuthStore;
    readonly abgOverlayController?: AbgOverlayController;
    readonly welcomeData?: WelcomeData;
    readonly missionControlServices?: MissionControlServicesLike;
    readonly subscribeEvents?: ChatTuiRuntimeEventSubscriber;
    readonly loadSessionSnapshot?: ChatTuiSessionSnapshotLoader;
    readonly actions?: ChatAppActions;
};
