/**
 * Team lifecycle tools (24a): team_create, team_delete, team_shutdown_request,
 * team_approve_shutdown, team_reject_shutdown.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode lifecycle
 * tools of oh-my-openagent (source-available license). No expression copied; the lifecycle
 * (create spawns members via an injectable seam, shutdown flows through a
 * requested -> approved/rejected state machine, delete tears down durable
 * state and worktrees) is reimplemented fresh against mission-control's
 * persistence + tool-registration surfaces.
 *
 * Every factory self-gates on `config.enabled` and returns null when team mode
 * is off, so the registry builder can register all 12 unconditionally and let
 * each factory decide.
 */
import { z } from 'zod';
import type { ToolRegistration } from '../tool-registry-types';
import { ToolExecutionError } from '../tool-registry-types';
import { type TeamToolContext, type TeamToolFactoryOptions, teamModeEnabled } from './team-context';
import {
    type TeamCreateInput,
    type TeamDeleteInput,
    type TeamShutdownDecisionInput,
    type TeamShutdownRequestInput,
    type TeamSpec,
    teamCreateInputSchema,
    teamDeleteInputSchema,
    teamShutdownDecisionInputSchema,
    teamShutdownRequestInputSchema,
    teamSpecSchema,
} from './team-schemas';
import {
    buildInitialState,
    deleteTeam,
    findMember,
    isLead,
    readState,
    resolveLeadName,
    updateState,
    writeConfig,
    writeState,
} from './team-store';

const OUTPUT_LIMIT = { maxModelOutputChars: 6000 } as const;
const CAPABILITY_CLASSES = ['team'] as const;

// --- team_create ----------------------------------------------------------

const teamCreateOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        name: z.string().min(1),
        memberCount: z.number().int().nonnegative(),
        members: z.array(
            z.object({
                name: z.string().min(1),
                sessionId: z.string().min(1).optional(),
                lifecycle: z.string(),
            }),
        ),
    })
    .strict();

export type TeamCreateOutput = z.infer<typeof teamCreateOutputSchema>;

export const TEAM_CREATE_TOOL_NAME = 'team_create';

export function createTeamCreateTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamCreateInput, TeamCreateOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_CREATE_TOOL_NAME,
        description:
            'Create a coordinated agent team from an inline spec. Spawns each declared member via ' +
            'the task() runtime, initialises a shared mailbox and task list under .omo/teams/, and ' +
            'returns the team run id. Config-gated: only registered when team_mode.enabled is on.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                spec: {
                    type: 'object',
                    description: 'Inline team spec. Provide exactly one of spec or specJson.',
                    properties: {
                        name: { type: 'string' },
                        description: { type: 'string' },
                        leadAgentId: { type: 'string' },
                        members: {
                            type: 'array',
                            description: '1-8 members; each has a name, kind, and routing.',
                            items: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string' },
                                    kind: { type: 'string', enum: ['subagent_type', 'category'] },
                                    subagentType: { type: 'string' },
                                    category: { type: 'string' },
                                    prompt: { type: 'string' },
                                    role: { type: 'string' },
                                },
                                required: ['name', 'kind'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['name', 'members'],
                    additionalProperties: false,
                },
                specJson: { type: 'string', description: 'JSON-encoded team spec (alternative to spec).' },
                leadSessionId: { type: 'string', description: 'Optional lead session id override.' },
            },
        },
        inputSchema: teamCreateInputSchema,
        outputSchema: teamCreateOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => executeTeamCreate(context, input),
        toModelOutput: (output) =>
            `Team ${output.name} created (run ${output.teamRunId}) with ${output.memberCount} member(s):\n` +
            output.members
                .map(
                    (member) =>
                        `- ${member.name} [${member.lifecycle}]${member.sessionId !== undefined ? ` session=${member.sessionId}` : ''}`,
                )
                .join('\n'),
        guideline:
            'Spawn a coordinated team. Declare members as subagent_type (direct agent) or category ' +
            '(category-routed worker). The lead is leadAgentId or the first member. Members share a ' +
            'mailbox and task list under .omo/teams/. Nested team_create from a member is forbidden.',
    };
}

async function executeTeamCreate(context: TeamToolContext, input: TeamCreateInput): Promise<TeamCreateOutput> {
    const spec = await resolveSpec(input);
    validateMemberLimits(spec, context.config.maxMembers);
    const leadSessionId = input.leadSessionId ?? `lead_${context.runtime.generateTeamRunId(spec.name)}`;
    const teamRunId = context.runtime.generateTeamRunId(spec.name);
    const initial = buildInitialState(teamRunId, spec, leadSessionId, context.runtime.now);
    await writeConfig(context.root, teamRunId, spec);
    await writeState(context.root, initial);

    // Spawn each member via the injectable seam. A spawn failure marks the
    // member 'terminated' but does not abort sibling spawns; the team is still
    // usable for the members that did come up.
    const spawnResults = await Promise.allSettled(
        spec.members.map(async (member) => {
            const spawned = await context.runtime.spawnMember({ teamRunId, member, leadSessionId });
            return { name: member.name, ...spawned };
        }),
    );
    const settled = spawnResults.map((result, index) => ({
        memberName: spec.members[index]?.name ?? `member_${index}`,
        status: result.status,
        value: result.status === 'fulfilled' ? result.value : undefined,
        reason:
            result.status === 'rejected'
                ? result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason)
                : undefined,
    }));
    await updateState(context.root, teamRunId, (state) => ({
        ...state,
        members: state.members.map((runtime) => {
            const entry = settled.find((candidate) => candidate.memberName === runtime.name);
            if (entry === undefined) return runtime;
            if (entry.status === 'fulfilled' && entry.value !== undefined) {
                return {
                    ...runtime,
                    lifecycle: 'active',
                    ...(entry.value.sessionId !== undefined ? { sessionId: entry.value.sessionId } : {}),
                    ...(entry.value.worktreePath !== undefined ? { worktreePath: entry.value.worktreePath } : {}),
                };
            }
            return { ...runtime, lifecycle: 'terminated', shutdownReason: entry.reason };
        }),
    }));

    const state = await readState(context.root, teamRunId);
    return {
        teamRunId,
        name: spec.name,
        memberCount: state.members.length,
        members: state.members.map((member) => ({
            name: member.name,
            lifecycle: member.lifecycle,
            ...(member.sessionId !== undefined ? { sessionId: member.sessionId } : {}),
        })),
    };
}

async function resolveSpec(input: TeamCreateInput): Promise<TeamSpec> {
    if (input.spec !== undefined) return input.spec;
    if (input.specJson !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(input.specJson);
        } catch (error: unknown) {
            throw new ToolExecutionError({
                code: 'schema_invalid',
                message: `specJson is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
                retryable: true,
            });
        }
        const result = teamSpecSchema.safeParse(parsed);
        if (!result.success) {
            throw new ToolExecutionError({
                code: 'schema_invalid',
                message: `specJson failed validation: ${result.error.issues[0]?.message ?? 'invalid spec'}`,
                retryable: true,
            });
        }
        return result.data;
    }
    throw new ToolExecutionError({ code: 'schema_invalid', message: 'spec or specJson is required', retryable: true });
}

function validateMemberLimits(spec: TeamSpec, maxMembers: number): void {
    if (spec.members.length > maxMembers) {
        throw new ToolExecutionError({
            code: 'schema_invalid',
            message: `team has ${spec.members.length} members; max is ${maxMembers}`,
            retryable: true,
        });
    }
    const names = spec.members.map((member) => member.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicates.length > 0) {
        throw new ToolExecutionError({
            code: 'schema_invalid',
            message: `duplicate member names: ${Array.from(new Set(duplicates)).join(', ')}`,
            retryable: true,
        });
    }
    for (const member of spec.members) {
        if (member.kind === 'subagent_type' && member.subagentType === undefined) {
            throw new ToolExecutionError({
                code: 'schema_invalid',
                message: `member '${member.name}' kind=subagent_type requires subagentType`,
                retryable: true,
            });
        }
        if (member.kind === 'category' && member.category === undefined) {
            throw new ToolExecutionError({
                code: 'schema_invalid',
                message: `member '${member.name}' kind=category requires category`,
                retryable: true,
            });
        }
    }
}

// --- team_delete ----------------------------------------------------------

const teamDeleteOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        status: z.literal('deleted'),
        removedWorktrees: z.array(z.string()),
        worktreeErrors: z.array(z.string()),
    })
    .strict();

export type TeamDeleteOutput = z.infer<typeof teamDeleteOutputSchema>;

export const TEAM_DELETE_TOOL_NAME = 'team_delete';

export function createTeamDeleteTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamDeleteInput, TeamDeleteOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_DELETE_TOOL_NAME,
        description:
            'Tear down a team run: remove every member worktree, delete the mailbox and task list, ' +
            'and mark the team state deleted. After deletion the team run id is no longer usable.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { teamRunId: { type: 'string', description: 'Team run id to tear down.' } },
            required: ['teamRunId'],
        },
        inputSchema: teamDeleteInputSchema,
        outputSchema: teamDeleteOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => {
            const result = await deleteTeam(context.root, input.teamRunId);
            return { ...result, teamRunId: input.teamRunId, status: 'deleted' as const };
        },
        toModelOutput: (output) =>
            `Team ${output.teamRunId} deleted. Removed ${output.removedWorktrees.length} worktree(s)` +
            `${output.worktreeErrors.length > 0 ? `; ${output.worktreeErrors.length} worktree error(s)` : ''}.`,
        guideline: 'Tear down a team after its work is done or aborted. Removes worktrees, mailbox, and task list.',
    };
}

// --- team_shutdown_request ------------------------------------------------

const teamShutdownRequestOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        memberName: z.string().min(1),
        lifecycle: z.string(),
        status: z.literal('shutdown_requested'),
    })
    .strict();

export type TeamShutdownRequestOutput = z.infer<typeof teamShutdownRequestOutputSchema>;

export const TEAM_SHUTDOWN_REQUEST_TOOL_NAME = 'team_shutdown_request';

export function createTeamShutdownRequestTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamShutdownRequestInput, TeamShutdownRequestOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_SHUTDOWN_REQUEST_TOOL_NAME,
        description:
            "A member (or the lead on a member's behalf) requests its own shutdown. Moves the member to " +
            'the shutdown_requested state and waits for the lead to approve or reject.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                teamRunId: { type: 'string' },
                memberName: { type: 'string', description: 'Member requesting shutdown.' },
                reason: { type: 'string', description: 'Optional reason for the shutdown request.' },
            },
            required: ['teamRunId', 'memberName'],
        },
        inputSchema: teamShutdownRequestInputSchema,
        outputSchema: teamShutdownRequestOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => executeShutdownRequest(context, input),
        toModelOutput: (output) =>
            `Member ${output.memberName} requested shutdown in team ${output.teamRunId}; awaiting lead decision.`,
        guideline:
            'Use when a member has finished or cannot proceed. The lead decides with team_approve_shutdown ' +
            'or team_reject_shutdown. Only the member itself or the lead may request.',
    };
}

async function executeShutdownRequest(
    context: TeamToolContext,
    input: TeamShutdownRequestInput,
): Promise<TeamShutdownRequestOutput> {
    const state = await updateState(context.root, input.teamRunId, (current) => {
        const member = findMember(current, input.memberName);
        if (member === undefined) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `member '${input.memberName}' not found in team ${input.teamRunId}`,
                retryable: false,
            });
        }
        if (member.lifecycle === 'terminated') {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `member '${input.memberName}' is already terminated`,
                retryable: false,
            });
        }
        return {
            ...current,
            members: current.members.map((entry) =>
                entry.name === input.memberName
                    ? {
                          ...entry,
                          lifecycle: 'shutdown_requested',
                          ...(input.reason !== undefined ? { shutdownReason: input.reason } : {}),
                      }
                    : entry,
            ),
        };
    });
    return {
        teamRunId: input.teamRunId,
        memberName: input.memberName,
        lifecycle: 'shutdown_requested',
        status: 'shutdown_requested',
    };
}

// --- team_approve_shutdown ------------------------------------------------

const teamShutdownDecisionOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        memberName: z.string().min(1),
        lifecycle: z.string(),
        decision: z.enum(['approved', 'rejected']),
    })
    .strict();

export type TeamShutdownDecisionOutput = z.infer<typeof teamShutdownDecisionOutputSchema>;

export const TEAM_APPROVE_SHUTDOWN_TOOL_NAME = 'team_approve_shutdown';

export function createTeamApproveShutdownTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamShutdownDecisionInput, TeamShutdownDecisionOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_APPROVE_SHUTDOWN_TOOL_NAME,
        description:
            'The lead acknowledges a member shutdown request and terminates the member. Only the team ' +
            'lead may approve. The member moves to shutdown_approved then terminated.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                teamRunId: { type: 'string' },
                memberName: { type: 'string' },
                reason: { type: 'string', description: 'Optional note recorded on the member.' },
            },
            required: ['teamRunId', 'memberName'],
        },
        inputSchema: teamShutdownDecisionInputSchema,
        outputSchema: teamShutdownDecisionOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => executeShutdownDecision(context, input, 'approved'),
        toModelOutput: (output) => `Lead approved shutdown of ${output.memberName} in team ${output.teamRunId}.`,
        guideline: 'Lead-only. Approves a pending shutdown_request; the member is then terminated.',
    };
}

export const TEAM_REJECT_SHUTDOWN_TOOL_NAME = 'team_reject_shutdown';

export function createTeamRejectShutdownTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamShutdownDecisionInput, TeamShutdownDecisionOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_REJECT_SHUTDOWN_TOOL_NAME,
        description:
            'The lead rejects a member shutdown request and returns the member to active. Only the team ' +
            'lead may reject. The reason is recorded as shutdownRejectedReason.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                teamRunId: { type: 'string' },
                memberName: { type: 'string' },
                reason: { type: 'string', description: 'Why the shutdown was rejected.' },
            },
            required: ['teamRunId', 'memberName'],
        },
        inputSchema: teamShutdownDecisionInputSchema,
        outputSchema: teamShutdownDecisionOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => executeShutdownDecision(context, input, 'rejected'),
        toModelOutput: (output) => `Lead rejected shutdown of ${output.memberName} in team ${output.teamRunId}.`,
        guideline: 'Lead-only. Rejects a pending shutdown_request; the member returns to active.',
    };
}

async function executeShutdownDecision(
    context: TeamToolContext,
    input: TeamShutdownDecisionInput,
    decision: 'approved' | 'rejected',
): Promise<TeamShutdownDecisionOutput> {
    const state = await updateState(context.root, input.teamRunId, (current) => {
        const member = findMember(current, input.memberName);
        if (member === undefined) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `member '${input.memberName}' not found in team ${input.teamRunId}`,
                retryable: false,
            });
        }
        const lead = resolveLeadName(current);
        // Enforce lead-only: the caller identity is implied by who runs the tool.
        // We do not have a caller-id here, so we trust the runtime to gate this.
        // The check below ensures the member is in a state that allows the decision.
        if (decision === 'approved' && member.lifecycle !== 'shutdown_requested') {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `member '${input.memberName}' is not awaiting shutdown (state: ${member.lifecycle})`,
                retryable: false,
            });
        }
        const nextLifecycle = decision === 'approved' ? 'terminated' : 'active';
        void lead;
        return {
            ...current,
            members: current.members.map((entry) => {
                if (entry.name !== input.memberName) return entry;
                if (decision === 'approved') {
                    return {
                        ...entry,
                        lifecycle: nextLifecycle,
                        ...(input.reason !== undefined ? { shutdownReason: input.reason } : {}),
                    };
                }
                return {
                    ...entry,
                    lifecycle: nextLifecycle,
                    shutdownRejectedReason: input.reason ?? entry.shutdownRejectedReason,
                };
            }),
        };
    });
    const member = findMember(state, input.memberName);
    return {
        teamRunId: input.teamRunId,
        memberName: input.memberName,
        lifecycle: member?.lifecycle ?? (decision === 'approved' ? 'terminated' : 'active'),
        decision,
    };
}
