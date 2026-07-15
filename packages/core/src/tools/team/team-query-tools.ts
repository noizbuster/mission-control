/**
 * Team query tools (24c, part 2): team_status, team_list.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode query tools
 * of oh-my-openagent (source-available license). No expression copied; the read-only status
 * projection (members + lifecycle + mailbox counts + task summary) and the
 * declared/active team listing are reimplemented fresh.
 */
import { z } from 'zod';
import type { ToolRegistration } from '../tool-registry-types';
import { ToolExecutionError } from '../tool-registry-types';
import { type TeamToolContext, type TeamToolFactoryOptions, teamModeEnabled } from './team-context';
import {
    type TeamListInput,
    type TeamStatusInput,
    teamListInputSchema,
    teamStatusInputSchema,
} from './team-schemas';
import { listTeams, mailboxCounts, readState, readTasks } from './team-store';

const OUTPUT_LIMIT = { maxModelOutputChars: 8000 } as const;
const CAPABILITY_CLASSES = ['team'] as const;

// --- team_status ----------------------------------------------------------

const teamStatusMemberSchema = z
    .object({
        name: z.string().min(1),
        lifecycle: z.string(),
        isLead: z.boolean(),
        unread: z.number().int().nonnegative(),
        sessionId: z.string().min(1).optional(),
    })
    .strict();

const teamStatusTaskSummarySchema = z
    .object({
        open: z.number().int().nonnegative(),
        claimed: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
    })
    .strict();

const teamStatusOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        name: z.string().min(1),
        status: z.string(),
        lead: z.string().min(1),
        members: z.array(teamStatusMemberSchema),
        tasks: teamStatusTaskSummarySchema,
    })
    .strict();

export type TeamStatusOutput = z.infer<typeof teamStatusOutputSchema>;

export const TEAM_STATUS_TOOL_NAME = 'team_status';

export function createTeamStatusTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamStatusInput, TeamStatusOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_STATUS_TOOL_NAME,
        description:
            'Report full team run status: members with lifecycle + unread mailbox counts, and a task ' +
            'summary broken down by status. Read-only.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { teamRunId: { type: 'string' } },
            required: ['teamRunId'],
        },
        inputSchema: teamStatusInputSchema,
        outputSchema: teamStatusOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => executeTeamStatus(context, input.teamRunId),
        toModelOutput: (output) => {
            const memberLines = output.members.map(
                (member) =>
                    `- ${member.name}${member.isLead ? ' (lead)' : ''} [${member.lifecycle}]${member.unread > 0 ? ` unread=${member.unread}` : ''}`,
            );
            const t = output.tasks;
            return (
                `Team ${output.name} (${output.teamRunId}) — ${output.status}\n` +
                `Members (${output.members.length}):\n${memberLines.join('\n')}\n` +
                `Tasks: ${t.open} open, ${t.claimed} claimed, ${t.completed} completed, ${t.failed} failed (${t.total} total)`
            );
        },
        guideline: 'Inspect overall team progress before delegating or claiming work.',
    };
}

async function executeTeamStatus(context: TeamToolContext, teamRunId: string): Promise<TeamStatusOutput> {
    const state = await readState(context.root, teamRunId);
    if (state.status === 'deleted') {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `team ${teamRunId} is deleted`,
            retryable: false,
        });
    }
    const tasks = await readTasks(context.root, teamRunId);
    const unread = await mailboxCounts(context.root, teamRunId);
    const lead = state.spec.leadAgentId ?? state.members[0]?.name ?? '';
    const summary = { open: 0, claimed: 0, completed: 0, failed: 0, total: 0 };
    for (const task of tasks) {
        if (task.status !== 'deleted') summary.total += 1;
        if (task.status === 'open') summary.open += 1;
        else if (task.status === 'claimed') summary.claimed += 1;
        else if (task.status === 'completed') summary.completed += 1;
        else if (task.status === 'failed') summary.failed += 1;
    }
    return {
        teamRunId,
        name: state.spec.name,
        status: state.status,
        lead,
        members: state.members.map((member) => ({
            name: member.name,
            lifecycle: member.lifecycle,
            isLead: member.name === lead,
            unread: unread.get(member.name) ?? 0,
            ...(member.sessionId !== undefined ? { sessionId: member.sessionId } : {}),
        })),
        tasks: summary,
    };
}

// --- team_list ------------------------------------------------------------

const teamListOutputSchema = z
    .object({
        teams: z.array(
            z.object({
                teamRunId: z.string().min(1),
                name: z.string().min(1),
                status: z.string(),
                memberCount: z.number().int().nonnegative(),
            }),
        ),
        total: z.number().int().nonnegative(),
    })
    .strict();

export type TeamListOutput = z.infer<typeof teamListOutputSchema>;

export const TEAM_LIST_TOOL_NAME = 'team_list';

export function createTeamListTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamListInput, TeamListOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_LIST_TOOL_NAME,
        description: 'List declared and active team runs under .omo/teams/. Read-only.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
        },
        inputSchema: teamListInputSchema,
        outputSchema: teamListOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async () => {
            const teams = await listTeams(context.root);
            return {
                total: teams.length,
                teams: teams.map((entry) => ({
                    teamRunId: entry.teamRunId,
                    name: entry.name,
                    status: entry.status,
                    memberCount: entry.memberCount,
                })),
            };
        },
        toModelOutput: (output) => {
            if (output.teams.length === 0) return 'No team runs.';
            const lines = output.teams.map(
                (team) => `- ${team.teamRunId} (${team.name}) [${team.status}] ${team.memberCount} member(s)`,
            );
            return `${output.teams.length} team run(s):\n${lines.join('\n')}`;
        },
        guideline: 'Discover existing teams before creating a new one or joining one.',
    };
}
