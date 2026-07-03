/**
 * Team-mode tool barrel (Task 24): 12 config-gated team_* tools.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode feature of
 * oh-my-openagent (source-available license). No expression copied; the
 * mailbox, tasklist, state-store, lifecycle, and tool factories here are
 * reimplemented fresh against mission-control's persistence + tool-registration
 * surfaces.
 *
 * Public entry point: {@linkcode buildTeamToolRegistrations} returns the 12
 * registrations when `team_mode.enabled` is on, and `[]` otherwise (the
 * default). The factories self-gate on the same flag.
 */

export {
    createDefaultTeamToolRuntime,
    type MemberSpawnRequest,
    type SpawnedMember,
    type TeamIrcBridge,
    type TeamToolContext,
    type TeamToolFactoryOptions,
    TeamToolNotImplementedError,
    type TeamToolRuntime,
    teamModeEnabled,
} from './team-context.js';
export {
    createTeamApproveShutdownTool,
    createTeamCreateTool,
    createTeamDeleteTool,
    createTeamRejectShutdownTool,
    createTeamShutdownRequestTool,
    TEAM_APPROVE_SHUTDOWN_TOOL_NAME,
    TEAM_CREATE_TOOL_NAME,
    TEAM_DELETE_TOOL_NAME,
    TEAM_REJECT_SHUTDOWN_TOOL_NAME,
    TEAM_SHUTDOWN_REQUEST_TOOL_NAME,
} from './team-lifecycle-tools.js';
export {
    createTeamSendMessageTool,
    TEAM_SEND_MESSAGE_TOOL_NAME,
} from './team-messaging-tools.js';
export {
    createTeamListTool,
    createTeamStatusTool,
    TEAM_LIST_TOOL_NAME,
    TEAM_STATUS_TOOL_NAME,
} from './team-query-tools.js';
export {
    type BuildTeamToolsOptions,
    buildTeamToolRegistrations,
    TEAM_TOOL_COUNT,
    TEAM_TOOL_NAMES,
} from './team-registry.js';
export {
    DEFAULT_TEAM_MODE_CONFIG,
    type MemberRuntime,
    type MemberSpec,
    type TaskList,
    type TaskStatus,
    type TeamMessage,
    type TeamModeConfig,
    type TeamSpec,
    type TeamState,
    type TeamTask,
    teamModeConfigSchema,
    teamSpecSchema,
} from './team-schemas.js';
export {
    buildInitialState,
    createTask,
    deleteTeam,
    getTask,
    listTeams,
    mailboxCounts,
    readMailbox,
    readState,
    readTasks,
    type TaskClaimResult,
    type TeamListing,
    TeamStoreError,
    teamDir,
    updateState,
    updateTask,
    writeConfig,
    writeState,
} from './team-store.js';
export {
    createTeamTaskCreateTool,
    createTeamTaskGetTool,
    createTeamTaskListTool,
    createTeamTaskUpdateTool,
    TEAM_TASK_CREATE_TOOL_NAME,
    TEAM_TASK_GET_TOOL_NAME,
    TEAM_TASK_LIST_TOOL_NAME,
    TEAM_TASK_UPDATE_TOOL_NAME,
} from './team-task-tools.js';
