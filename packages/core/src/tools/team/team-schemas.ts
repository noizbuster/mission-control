/**
 * Team-mode schemas and config.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode feature of
 * upstream agent harness (source-available license). No expression copied; the shapes here are derived
 * fresh from the team-coordination problem (shared mailbox + task list + lead
 * lifecycle over a durable `.omo/teams/` directory).
 *
 * The `team_mode.enabled` gate defaults to false: the 12 team_* tools are not
 * registered unless the caller opts in.
 */
import { z } from 'zod';

// --- Config gate ----------------------------------------------------------

export const teamModeConfigSchema = z
    .object({
        enabled: z.boolean().default(false),
        maxParallelMembers: z.number().int().min(1).max(8).default(4),
        maxMembers: z.number().int().min(1).max(8).default(8),
        messagePayloadMaxBytes: z.number().int().min(1024).default(32768),
        recipientUnreadMaxBytes: z.number().int().min(1024).default(262144),
    })
    .strict();

export type TeamModeConfig = z.infer<typeof teamModeConfigSchema>;

export const DEFAULT_TEAM_MODE_CONFIG: TeamModeConfig = teamModeConfigSchema.parse({});

// --- Member + team spec ---------------------------------------------------

export const memberKinds = ['subagent_type', 'category'] as const;
export type MemberKind = (typeof memberKinds)[number];

export const memberSpecSchema = z
    .object({
        name: z.string().min(1),
        kind: z.enum(memberKinds),
        subagentType: z.string().min(1).optional(),
        category: z.string().min(1).optional(),
        prompt: z.string().optional(),
        role: z.string().optional(),
    })
    .strict();

export type MemberSpec = z.infer<typeof memberSpecSchema>;

export const teamSpecSchema = z
    .object({
        name: z.string().min(1),
        description: z.string().optional(),
        leadAgentId: z.string().min(1).optional(),
        members: z.array(memberSpecSchema).min(1),
    })
    .strict();

export type TeamSpec = z.infer<typeof teamSpecSchema>;

// --- Runtime member state -------------------------------------------------

export const memberLifecycleStates = [
    'spawning',
    'active',
    'shutdown_requested',
    'shutdown_approved',
    'shutdown_rejected',
    'terminated',
] as const;
export type MemberLifecycleState = (typeof memberLifecycleStates)[number];

export const memberRuntimeSchema = z
    .object({
        name: z.string().min(1),
        kind: z.enum(memberKinds),
        subagentType: z.string().min(1).optional(),
        category: z.string().min(1).optional(),
        role: z.string().optional(),
        prompt: z.string().optional(),
        sessionId: z.string().min(1).optional(),
        worktreePath: z.string().optional(),
        lifecycle: z.enum(memberLifecycleStates),
        shutdownReason: z.string().optional(),
        shutdownRejectedReason: z.string().optional(),
    })
    .strict();

export type MemberRuntime = z.infer<typeof memberRuntimeSchema>;

export const teamStateSchema = z
    .object({
        teamRunId: z.string().min(1),
        spec: teamSpecSchema,
        leadSessionId: z.string().min(1),
        members: z.array(memberRuntimeSchema),
        createdAt: z.string(),
        updatedAt: z.string(),
        status: z.enum(['active', 'deleted']),
    })
    .strict();

export type TeamState = z.infer<typeof teamStateSchema>;

// --- Mailbox message ------------------------------------------------------

export const messageKinds = [
    'message',
    'announcement',
    'shutdown_request',
    'shutdown_approved',
    'shutdown_rejected',
] as const;
export type MessageKind = (typeof messageKinds)[number];

export const messageSchema = z
    .object({
        messageId: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        body: z.string(),
        kind: z.enum(messageKinds),
        timestamp: z.number().int().nonnegative(),
        correlationId: z.string().min(1).optional(),
        summary: z.string().optional(),
    })
    .strict();

export type TeamMessage = z.infer<typeof messageSchema>;

// --- Shared task list -----------------------------------------------------

export const taskStatuses = ['open', 'claimed', 'completed', 'failed', 'deleted'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const teamTaskSchema = z
    .object({
        taskId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        status: z.enum(taskStatuses),
        owner: z.string().min(1).optional(),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        dependencies: z.array(z.string().min(1)).default([]),
    })
    .strict();

export type TeamTask = z.infer<typeof teamTaskSchema>;

export const taskListSchema = z
    .object({
        version: z.literal(1),
        tasks: z.array(teamTaskSchema),
    })
    .strict();

export type TaskList = z.infer<typeof taskListSchema>;

export const EMPTY_TASK_LIST: TaskList = { version: 1, tasks: [] };

// --- Tool input schemas ---------------------------------------------------

export const teamCreateInputSchema = z
    .object({
        spec: teamSpecSchema.optional(),
        specJson: z.string().min(1).optional(),
        leadSessionId: z.string().min(1).optional(),
    })
    .strict()
    .refine((data) => data.spec !== undefined || data.specJson !== undefined, {
        message: "Provide either 'spec' or 'specJson'",
    })
    .refine((data) => !(data.spec !== undefined && data.specJson !== undefined), {
        message: "Provide 'spec' or 'specJson', not both",
    });

export type TeamCreateInput = z.infer<typeof teamCreateInputSchema>;

export const teamDeleteInputSchema = z
    .object({
        teamRunId: z.string().min(1),
    })
    .strict();

export type TeamDeleteInput = z.infer<typeof teamDeleteInputSchema>;

export const teamShutdownRequestInputSchema = z
    .object({
        teamRunId: z.string().min(1),
        memberName: z.string().min(1),
        reason: z.string().optional(),
    })
    .strict();

export type TeamShutdownRequestInput = z.infer<typeof teamShutdownRequestInputSchema>;

export const teamShutdownDecisionInputSchema = z
    .object({
        teamRunId: z.string().min(1),
        memberName: z.string().min(1),
        reason: z.string().optional(),
    })
    .strict();

export type TeamShutdownDecisionInput = z.infer<typeof teamShutdownDecisionInputSchema>;

export const teamSendMessageInputSchema = z
    .object({
        teamRunId: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        body: z.string(),
        kind: z.enum(['message', 'announcement']).optional(),
        correlationId: z.string().min(1).optional(),
        summary: z.string().optional(),
    })
    .strict();

export type TeamSendMessageInput = z.infer<typeof teamSendMessageInputSchema>;

export const teamTaskCreateInputSchema = z
    .object({
        teamRunId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        dependencies: z.array(z.string().min(1)).optional(),
    })
    .strict();

export type TeamTaskCreateInput = z.infer<typeof teamTaskCreateInputSchema>;

export const teamTaskListInputSchema = z
    .object({
        teamRunId: z.string().min(1),
        status: z.enum(taskStatuses).optional(),
        owner: z.string().min(1).optional(),
    })
    .strict();

export type TeamTaskListInput = z.infer<typeof teamTaskListInputSchema>;

export const teamTaskUpdateInputSchema = z
    .object({
        teamRunId: z.string().min(1),
        taskId: z.string().min(1),
        status: z.enum(taskStatuses),
        owner: z.string().min(1).optional(),
        claimant: z.string().min(1).optional(),
        note: z.string().optional(),
    })
    .strict();

export type TeamTaskUpdateInput = z.infer<typeof teamTaskUpdateInputSchema>;

export const teamTaskGetInputSchema = z
    .object({
        teamRunId: z.string().min(1),
        taskId: z.string().min(1),
    })
    .strict();

export type TeamTaskGetInput = z.infer<typeof teamTaskGetInputSchema>;

export const teamStatusInputSchema = z
    .object({
        teamRunId: z.string().min(1),
    })
    .strict();

export type TeamStatusInput = z.infer<typeof teamStatusInputSchema>;

export const teamListInputSchema = z.object({}).strict().optional().default({});

export type TeamListInput = z.infer<typeof teamListInputSchema>;
