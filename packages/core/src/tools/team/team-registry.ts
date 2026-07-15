/**
 * Team tool registry: builds all 12 team_* registrations behind the config gate.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode tool
 * registration of oh-my-openagent (source-available license). No expression copied. When
 * `team_mode.enabled` is false (the default) `buildTeamToolRegistrations`
 * returns an empty array and nothing is registered. Each factory also
 * self-gates on the same flag, so wiring is safe to call unconditionally.
 */
import type { ToolRegistration } from '../tool-registry-types';
import {
    createDefaultTeamToolRuntime,
    type TeamIrcBridge,
    type TeamToolContext,
    type TeamToolRuntime,
} from './team-context';
import {
    createTeamApproveShutdownTool,
    createTeamCreateTool,
    createTeamDeleteTool,
    createTeamRejectShutdownTool,
    createTeamShutdownRequestTool,
} from './team-lifecycle-tools';
import { createTeamSendMessageTool } from './team-messaging-tools';
import { createTeamListTool, createTeamStatusTool } from './team-query-tools';
import type { TeamModeConfig } from './team-schemas';
import { teamModeConfigSchema } from './team-schemas';
import {
    createTeamTaskCreateTool,
    createTeamTaskGetTool,
    createTeamTaskListTool,
    createTeamTaskUpdateTool,
} from './team-task-tools';

export interface BuildTeamToolsOptions {
    /** Workspace root backing `.omo/teams/`. Required when enabled. */
    readonly root: string;
    /** Resolved team-mode config (partial; schema defaults fill the rest). Defaults to disabled. */
    readonly config?: Partial<TeamModeConfig>;
    /** Injectable runtime for member spawning. Defaults to the not-implemented runtime. */
    readonly runtime?: TeamToolRuntime;
    /** Optional live-delivery irc bridge. */
    readonly ircBridge?: TeamIrcBridge;
}

/**
 * Build the 12 team_* tool registrations. Returns `[]` when team mode is off.
 * Every factory self-gates on `config.enabled`, so this is the single config
 * gate the CLI wiring calls.
 */
export function buildTeamToolRegistrations(options: BuildTeamToolsOptions): ToolRegistration<unknown, unknown>[] {
    const config = teamModeConfigSchema.parse(options.config ?? {});
    if (!config.enabled) return [];
    if (options.root.length === 0) return [];
    const runtime = options.runtime ?? createDefaultTeamToolRuntime();
    const context: TeamToolContext = {
        root: options.root,
        config,
        runtime,
        ...(options.ircBridge !== undefined ? { ircBridge: options.ircBridge } : {}),
    };
    const factories = [
        createTeamCreateTool,
        createTeamDeleteTool,
        createTeamShutdownRequestTool,
        createTeamApproveShutdownTool,
        createTeamRejectShutdownTool,
        createTeamSendMessageTool,
        createTeamTaskCreateTool,
        createTeamTaskListTool,
        createTeamTaskUpdateTool,
        createTeamTaskGetTool,
        createTeamStatusTool,
        createTeamListTool,
    ];
    const registrations: ToolRegistration<unknown, unknown>[] = [];
    for (const factory of factories) {
        const registration = factory({ context });
        if (registration !== null) {
            registrations.push(registration as ToolRegistration<unknown, unknown>);
        }
    }
    return registrations;
}

/** Names of all 12 team tools, in registration order. */
export const TEAM_TOOL_NAMES = [
    'team_create',
    'team_delete',
    'team_shutdown_request',
    'team_approve_shutdown',
    'team_reject_shutdown',
    'team_send_message',
    'team_task_create',
    'team_task_list',
    'team_task_update',
    'team_task_get',
    'team_status',
    'team_list',
] as const;

export const TEAM_TOOL_COUNT = TEAM_TOOL_NAMES.length;
