/**
 * Team task tools (24c, part 1): team_task_create, team_task_list,
 * team_task_update, team_task_get.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode task list
 * of upstream agent harness (source-available license). No expression copied; the task model (a shared
 * JSON list under an exclusive lockfile, atomic claim via read-modify-write
 * inside the lock, explicit open->claimed->completed/failed/deleted state
 * machine) is reimplemented fresh against mission-control's store helpers.
 *
 * `team_task_update` with status="claimed" is the atomic claim: under the
 * lockfile the claimant only wins if the task is still `open`, so concurrent
 * claimants serialise and exactly one succeeds.
 */
import { z } from 'zod';
import type { ToolRegistration } from '../tool-registry-types';
import { ToolExecutionError } from '../tool-registry-types';
import { type TeamToolContext, type TeamToolFactoryOptions, teamModeEnabled } from './team-context';
import {
    type TeamTaskCreateInput,
    type TeamTaskGetInput,
    type TeamTaskListInput,
    type TeamTaskUpdateInput,
    teamTaskCreateInputSchema,
    teamTaskGetInputSchema,
    teamTaskListInputSchema,
    teamTaskUpdateInputSchema,
} from './team-schemas';
import { createTask, getTask, readState, readTasks, updateTask } from './team-store';

const OUTPUT_LIMIT = { maxModelOutputChars: 6000 } as const;
const CAPABILITY_CLASSES = ['team'] as const;

// --- team_task_create -----------------------------------------------------

const teamTaskCreateOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        taskId: z.string().min(1),
        title: z.string().min(1),
        status: z.literal('open'),
    })
    .strict();

export type TeamTaskCreateOutput = z.infer<typeof teamTaskCreateOutputSchema>;

export const TEAM_TASK_CREATE_TOOL_NAME = 'team_task_create';

export function createTeamTaskCreateTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamTaskCreateInput, TeamTaskCreateOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_TASK_CREATE_TOOL_NAME,
        description:
            'Create a task on the shared team task list. New tasks start in status "open" and can be ' +
            'claimed by any active member via team_task_update.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                teamRunId: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                dependencies: { type: 'array', items: { type: 'string' } },
            },
            required: ['teamRunId', 'title'],
        },
        inputSchema: teamTaskCreateInputSchema,
        outputSchema: teamTaskCreateOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => {
            await assertTeamActive(context, input.teamRunId);
            const task = await createTask(context.root, input.teamRunId, {
                title: input.title,
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.dependencies !== undefined ? { dependencies: input.dependencies } : {}),
            });
            return { teamRunId: input.teamRunId, taskId: task.taskId, title: task.title, status: 'open' };
        },
        toModelOutput: (output) => `Created task ${output.taskId} (${output.title}) in team ${output.teamRunId}.`,
        guideline:
            'Add work items to the shared list. Keep titles short; put detail in description. Declare ' +
            'dependencies so members can pick unblocked work first.',
    };
}

// --- team_task_list -------------------------------------------------------

const teamTaskListItemSchema = z
    .object({
        taskId: z.string().min(1),
        title: z.string().min(1),
        status: z.string(),
        owner: z.string().optional(),
    })
    .strict();

const teamTaskListOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        tasks: z.array(teamTaskListItemSchema),
        total: z.number().int().nonnegative(),
    })
    .strict();

export type TeamTaskListOutput = z.infer<typeof teamTaskListOutputSchema>;

export const TEAM_TASK_LIST_TOOL_NAME = 'team_task_list';

export function createTeamTaskListTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamTaskListInput, TeamTaskListOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_TASK_LIST_TOOL_NAME,
        description:
            'List tasks on the shared team task list. Optional filters: status (open/claimed/completed/' +
            'failed/deleted) and owner (member name). Deleted tasks are excluded unless status=deleted.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                teamRunId: { type: 'string' },
                status: { type: 'string', enum: ['open', 'claimed', 'completed', 'failed', 'deleted'] },
                owner: { type: 'string' },
            },
            required: ['teamRunId'],
        },
        inputSchema: teamTaskListInputSchema,
        outputSchema: teamTaskListOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => {
            await assertTeamActive(context, input.teamRunId);
            const all = await readTasks(context.root, input.teamRunId);
            const filtered = all.filter((task) => {
                if (input.status !== undefined && task.status !== input.status) return false;
                if (input.status === undefined && task.status === 'deleted') return false;
                if (input.owner !== undefined && task.owner !== input.owner) return false;
                return true;
            });
            return {
                teamRunId: input.teamRunId,
                total: filtered.length,
                tasks: filtered.map((task) => ({
                    taskId: task.taskId,
                    title: task.title,
                    status: task.status,
                    ...(task.owner !== undefined ? { owner: task.owner } : {}),
                })),
            };
        },
        toModelOutput: (output) => {
            if (output.tasks.length === 0) return `No tasks in team ${output.teamRunId}.`;
            const lines = output.tasks.map(
                (task) =>
                    `- ${task.taskId} [${task.status}]${task.owner !== undefined ? ` owner=${task.owner}` : ''} ${task.title}`,
            );
            return `${output.tasks.length} task(s) in team ${output.teamRunId}:\n${lines.join('\n')}`;
        },
        guideline:
            'Survey available work. Filter status=open for unclaimed tasks, status=claimed&owner=<self> for ' +
            'your in-progress work.',
    };
}

// --- team_task_update -----------------------------------------------------

const teamTaskUpdateOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        taskId: z.string().min(1),
        status: z.string(),
        owner: z.string().optional(),
        claimed: z.boolean().optional(),
        error: z.string().optional(),
    })
    .strict();

export type TeamTaskUpdateOutput = z.infer<typeof teamTaskUpdateOutputSchema>;

export const TEAM_TASK_UPDATE_TOOL_NAME = 'team_task_update';

export function createTeamTaskUpdateTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamTaskUpdateInput, TeamTaskUpdateOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_TASK_UPDATE_TOOL_NAME,
        description:
            'Update a task status. The claim transition (status="claimed") is atomic: only one member can ' +
            'claim a given open task; concurrent claims resolve with exactly one winner. Use ' +
            'status="completed"/"failed" to finish, "open" to release a claim, "deleted" to remove.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                teamRunId: { type: 'string' },
                taskId: { type: 'string' },
                status: { type: 'string', enum: ['open', 'claimed', 'completed', 'failed', 'deleted'] },
                owner: { type: 'string', description: 'Owner for non-claim transitions (optional, preserved).' },
                claimant: { type: 'string', description: 'Required for status="claimed"; becomes the owner.' },
                note: { type: 'string' },
            },
            required: ['teamRunId', 'taskId', 'status'],
        },
        inputSchema: teamTaskUpdateInputSchema,
        outputSchema: teamTaskUpdateOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => {
            await assertTeamActive(context, input.teamRunId);
            const result = await updateTask(context.root, input.teamRunId, input.taskId, {
                status: input.status,
                ...(input.owner !== undefined ? { owner: input.owner } : {}),
                ...(input.claimant !== undefined ? { claimant: input.claimant } : {}),
            });
            if (!result.ok) {
                const reason =
                    result.reason === 'already_claimed'
                        ? `task ${input.taskId} is already claimed${result.task?.owner !== undefined ? ` by ${result.task.owner}` : ''}`
                        : result.reason === 'invalid_transition'
                          ? `cannot move task ${input.taskId} from ${result.task?.status ?? 'unknown'} to ${input.status}`
                          : `task ${input.taskId} not found`;
                return {
                    teamRunId: input.teamRunId,
                    taskId: input.taskId,
                    status: result.task?.status ?? input.status,
                    ...(result.task?.owner !== undefined ? { owner: result.task.owner } : {}),
                    error: reason,
                };
            }
            return {
                teamRunId: input.teamRunId,
                taskId: input.taskId,
                status: result.task.status,
                ...(result.task.owner !== undefined ? { owner: result.task.owner } : {}),
                ...(input.status === 'claimed' ? { claimed: true } : {}),
            };
        },
        toModelOutput: (output) => {
            if (output.error !== undefined) return `${output.error}`;
            if (output.claimed === true) {
                return `Claimed task ${output.taskId} in team ${output.teamRunId}${output.owner !== undefined ? ` as ${output.owner}` : ''}.`;
            }
            return `Task ${output.taskId} now ${output.status} in team ${output.teamRunId}.`;
        },
        guideline:
            'Claim with status="claimed" + claimant=<your name>; the claim is atomic so racing claimants ' +
            'resolve safely. Mark status="completed" when done, "failed" to retry, "open" to release, ' +
            '"deleted" to remove. Check the returned error field on a failed claim.',
    };
}

// --- team_task_get --------------------------------------------------------

const teamTaskGetOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        taskId: z.string().min(1),
        title: z.string().min(1).optional(),
        status: z.string().optional(),
        owner: z.string().optional(),
        description: z.string().optional(),
        dependencies: z.array(z.string().min(1)).optional(),
        found: z.boolean(),
    })
    .strict();

export type TeamTaskGetOutput = z.infer<typeof teamTaskGetOutputSchema>;

export const TEAM_TASK_GET_TOOL_NAME = 'team_task_get';

export function createTeamTaskGetTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamTaskGetInput, TeamTaskGetOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_TASK_GET_TOOL_NAME,
        description: 'Fetch a single task by id, including its description and dependencies.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { teamRunId: { type: 'string' }, taskId: { type: 'string' } },
            required: ['teamRunId', 'taskId'],
        },
        inputSchema: teamTaskGetInputSchema,
        outputSchema: teamTaskGetOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => {
            await assertTeamActive(context, input.teamRunId);
            const task = await getTask(context.root, input.teamRunId, input.taskId);
            if (task === undefined) {
                return { teamRunId: input.teamRunId, taskId: input.taskId, found: false };
            }
            return {
                teamRunId: input.teamRunId,
                taskId: task.taskId,
                title: task.title,
                status: task.status,
                found: true,
                ...(task.owner !== undefined ? { owner: task.owner } : {}),
                ...(task.description !== undefined ? { description: task.description } : {}),
                ...(task.dependencies.length > 0 ? { dependencies: [...task.dependencies] } : {}),
            };
        },
        toModelOutput: (output) =>
            output.found
                ? `${output.taskId} [${output.status ?? 'unknown'}]${output.owner !== undefined ? ` owner=${output.owner}` : ''} ${output.title ?? ''}`
                : `Task ${output.taskId} not found in team ${output.teamRunId}.`,
        guideline: 'Inspect a task before claiming or after a status change.',
    };
}

// --- shared guard ---------------------------------------------------------

async function assertTeamActive(context: TeamToolContext, teamRunId: string): Promise<void> {
    const state = await readState(context.root, teamRunId);
    if (state.status === 'deleted') {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `team ${teamRunId} is deleted`,
            retryable: false,
        });
    }
}
