/**
 * `session_info` tool — metadata and statistics for a single durable session.
 *
 * Read layer over the EXISTING `<dataDir>/sessions/<id>.jsonl` store (see
 * `session-tools-shared.ts`). Capability class `['read']`, no approval.
 */

import { z } from 'zod';
import { readSessionProjection, type SessionToolsOptions, summarizeProjection } from './session-tools-shared.js';
import type { ToolRegistration } from './tool-registry-types.js';

const OUTPUT_LIMIT_CHARS = 4000;

export const sessionInfoInputSchema = z.object({
    session_id: z.string().min(1).describe('Session ID to inspect.'),
});

export type SessionInfoInput = z.infer<typeof sessionInfoInputSchema>;

export const sessionInfoOutputSchema = z.object({
    sessionId: z.string(),
    found: z.boolean(),
    status: z.string().optional(),
    eventCount: z.number().optional(),
    messageCount: z.number().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    cwd: z.string().optional(),
    sessionName: z.string().optional(),
    agentsUsed: z.array(z.string()).optional(),
});

export type SessionInfoOutput = z.infer<typeof sessionInfoOutputSchema>;

export const sessionInfoParametersJsonSchema = {
    type: 'object',
    properties: {
        session_id: { type: 'string', description: 'Session ID to inspect.' },
    },
    required: ['session_id'],
    additionalProperties: false,
} as const;

export function formatSessionInfoModelOutput(output: SessionInfoOutput): string {
    if (!output.found) {
        return `Session not found: ${output.sessionId}`;
    }
    const agents =
        output.agentsUsed !== undefined && output.agentsUsed.length > 0 ? output.agentsUsed.join(', ') : 'none';
    const lines: string[] = [
        `Session ID: ${output.sessionId}`,
        `Status: ${output.status ?? 'unknown'}`,
        `Events: ${output.eventCount ?? 0}`,
        `Messages: ${output.messageCount ?? 0}`,
        `Created: ${output.createdAt ?? 'N/A'}`,
        `Updated: ${output.updatedAt ?? 'N/A'}`,
        `Working Directory: ${output.cwd ?? 'N/A'}`,
        `Agents Used: ${agents}`,
    ];
    if (output.sessionName !== undefined) {
        lines.push(`Name: ${output.sessionName}`);
    }
    return lines.join('\n');
}

export function createSessionInfoToolRegistration(
    options?: SessionToolsOptions,
): ToolRegistration<SessionInfoInput, SessionInfoOutput> {
    return {
        name: 'session_info',
        description:
            'Get metadata and statistics about a durable mission-control session (status, event/message counts, timestamps, agents used). Read-only; no approval.',
        capabilityClasses: ['read'],
        parametersJsonSchema: sessionInfoParametersJsonSchema,
        inputSchema: sessionInfoInputSchema,
        outputSchema: sessionInfoOutputSchema,
        outputLimit: { maxModelOutputChars: OUTPUT_LIMIT_CHARS },
        execute: async (input) => {
            const read = await readSessionProjection(input.session_id, options);
            if (read.kind !== 'found' || read.projection === undefined) {
                return { sessionId: input.session_id, found: false };
            }
            const summary = summarizeProjection(read.projection.sessionId, read.projection);
            return {
                sessionId: summary.sessionId,
                found: true,
                status: summary.status,
                eventCount: summary.eventCount,
                messageCount: summary.messageCount,
                ...(summary.createdAt !== undefined ? { createdAt: summary.createdAt } : {}),
                ...(summary.updatedAt !== undefined ? { updatedAt: summary.updatedAt } : {}),
                ...(summary.cwd !== undefined ? { cwd: summary.cwd } : {}),
                ...(summary.sessionName !== undefined ? { sessionName: summary.sessionName } : {}),
                agentsUsed: summary.agentsUsed,
            };
        },
        toModelOutput: formatSessionInfoModelOutput,
    };
}
