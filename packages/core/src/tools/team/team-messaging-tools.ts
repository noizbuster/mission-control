/**
 * Team messaging tool (24b): team_send_message.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode mailbox of
 * upstream agent harness (source-available license). No expression copied; the delivery model (each
 * recipient has an append-only `.jsonl` mailbox, broadcasts fan out to every
 * active member, lead-only broadcasts enforced at execution, optional live
 * in-process bridge via the `irc` bus) is reimplemented fresh.
 *
 * The durable mailbox is the source of truth; the irc bridge is a side channel
 * for waking live in-process peers. Mailbox appends use O_APPEND so concurrent
 * writers do not interleave a single line.
 */

import { z } from 'zod';
import type { ToolRegistration } from '../tool-registry-types';
import { ToolExecutionError } from '../tool-registry-types';
import { type TeamToolContext, type TeamToolFactoryOptions, teamModeEnabled } from './team-context';
import { type TeamMessage, type TeamSendMessageInput, teamSendMessageInputSchema } from './team-schemas';
import { appendMessage, findMember, isLead, readState, resolveLeadName } from './team-store';
import { randomUUID } from 'node:crypto';

const OUTPUT_LIMIT = { maxModelOutputChars: 6000 } as const;
const CAPABILITY_CLASSES = ['team'] as const;

export const TEAM_SEND_MESSAGE_TOOL_NAME = 'team_send_message';

const teamSendMessageOutputSchema = z
    .object({
        teamRunId: z.string().min(1),
        messageId: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        deliveredTo: z.array(z.string().min(1)),
        broadcast: z.boolean(),
    })
    .strict();

export type TeamSendMessageOutput = z.infer<typeof teamSendMessageOutputSchema>;

export function createTeamSendMessageTool(
    options: TeamToolFactoryOptions,
): ToolRegistration<TeamSendMessageInput, TeamSendMessageOutput> | null {
    if (!teamModeEnabled(options.context.config)) return null;
    const { context } = options;

    return {
        name: TEAM_SEND_MESSAGE_TOOL_NAME,
        description:
            'Send a message to a team member by name, or broadcast with to="*" (lead only). Messages are ' +
            'appended to each recipient durable mailbox under .mc/teams/{id}/mailbox/. Returns the message ' +
            'id and the list of recipients delivered to.',
        capabilityClasses: [...CAPABILITY_CLASSES],
        parametersJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                teamRunId: { type: 'string' },
                from: { type: 'string', description: 'Sender member name.' },
                to: { type: 'string', description: 'Recipient member name, or "*" for a lead-only broadcast.' },
                body: { type: 'string' },
                kind: { type: 'string', enum: ['message', 'announcement'] },
                correlationId: { type: 'string' },
                summary: { type: 'string' },
            },
            required: ['teamRunId', 'from', 'to', 'body'],
        },
        inputSchema: teamSendMessageInputSchema,
        outputSchema: teamSendMessageOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => executeSendMessage(context, input),
        toModelOutput: (output) =>
            output.broadcast
                ? `Broadcast to ${output.deliveredTo.length} member(s) in team ${output.teamRunId}.`
                : `Delivered message ${output.messageId} to ${output.to} in team ${output.teamRunId}.`,
        guideline:
            'Coordinate through the shared mailbox. Direct sends go to one member; broadcasts (to="*") ' +
            'are lead-only and fan out to every active member. Pair with the recipient polling its mailbox. ' +
            'Use correlationId to thread replies.',
    };
}

async function executeSendMessage(
    context: TeamToolContext,
    input: TeamSendMessageInput,
): Promise<TeamSendMessageOutput> {
    const state = await readState(context.root, input.teamRunId);
    if (state.status === 'deleted') {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `team ${input.teamRunId} is deleted`,
            retryable: false,
        });
    }
    const sender = findMember(state, input.from);
    if (sender === undefined) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `sender '${input.from}' is not a member of team ${input.teamRunId}`,
            retryable: false,
        });
    }
    const payloadBytes = Buffer.byteLength(input.body, 'utf8');
    if (payloadBytes > context.config.messagePayloadMaxBytes) {
        throw new ToolExecutionError({
            code: 'schema_invalid',
            message: `message body is ${payloadBytes} bytes; max is ${context.config.messagePayloadMaxBytes}`,
            retryable: true,
        });
    }

    const broadcast = input.to === '*';
    if (broadcast && !isLead(state, input.from)) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `broadcast (to="*") is lead-only; lead is '${resolveLeadName(state)}'`,
            retryable: false,
        });
    }

    const recipients = broadcast
        ? state.members
              .filter((member) => member.name !== input.from && member.lifecycle !== 'terminated')
              .map((member) => member.name)
        : [input.to];

    if (!broadcast) {
        const recipient = findMember(state, input.to);
        if (recipient === undefined) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `recipient '${input.to}' is not a member of team ${input.teamRunId}`,
                retryable: false,
            });
        }
    }

    const timestamp = Date.now();
    const deliveredTo: string[] = [];
    let firstMessageId: string | undefined;
    for (const recipient of recipients) {
        const messageId = randomUUID();
        const message: TeamMessage = {
            messageId,
            from: input.from,
            to: recipient,
            body: input.body,
            kind: broadcast ? 'announcement' : (input.kind ?? 'message'),
            timestamp,
            ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
        };
        await appendMessage(context.root, input.teamRunId, recipient, message);
        deliveredTo.push(recipient);
        if (firstMessageId === undefined) firstMessageId = messageId;
        // Optional live bridge: forward to in-process peers (e.g. irc bus).
        if (context.ircBridge !== undefined) {
            try {
                await context.ircBridge.deliver({
                    teamRunId: input.teamRunId,
                    from: input.from,
                    to: recipient,
                    body: input.body,
                });
            } catch {
                // The durable mailbox already has the message; a live-bridge
                // failure is non-fatal (the recipient will still see it on poll).
            }
        }
    }

    return {
        teamRunId: input.teamRunId,
        messageId: firstMessageId ?? randomUUID(),
        from: input.from,
        to: input.to,
        deliveredTo,
        broadcast,
    };
}
