import { z } from 'zod';
import {
    extractMessages,
    readSessionProjection,
    redactSessionText,
    type SessionMessageEntry,
    type SessionToolsOptions,
    summarizeProjection,
} from './session-tools-shared';
import type { ToolRegistration } from './tool-registry-types';

const OUTPUT_LIMIT_CHARS = 8000;
const DEFAULT_MESSAGE_LIMIT = 200;

export const sessionReadInputSchema = z.object({
    session_id: z.string().min(1).describe('Session ID to read.'),
    limit: z.number().int().positive().optional().describe('Maximum number of messages to return.'),
    from_end: z.boolean().optional().describe('Read the most-recent messages first when true.'),
});

export type SessionReadInput = z.infer<typeof sessionReadInputSchema>;

export const sessionReadOutputSchema = z.object({
    sessionId: z.string(),
    found: z.boolean(),
    messages: z.array(
        z.object({
            messageId: z.string(),
            role: z.enum(['user', 'assistant']),
            text: z.string(),
            timestamp: z.string(),
            providerTurnId: z.string().optional(),
        }),
    ),
    truncated: z.boolean(),
});

export type SessionReadOutput = z.infer<typeof sessionReadOutputSchema>;

export const sessionReadParametersJsonSchema = {
    type: 'object',
    properties: {
        session_id: { type: 'string', description: 'Session ID to read.' },
        limit: { type: 'integer', description: 'Maximum messages to return (default all).' },
        from_end: { type: 'boolean', description: 'Read most-recent messages first when true.' },
    },
    required: ['session_id'],
    additionalProperties: false,
} as const;

export function formatSessionReadModelOutput(output: SessionReadOutput): string {
    if (!output.found) {
        return `Session not found: ${output.sessionId}`;
    }
    if (output.messages.length === 0) {
        return `No messages found in session ${output.sessionId}.`;
    }
    const lines: string[] = [`Session: ${output.sessionId}`];
    for (const message of output.messages) {
        const turn = message.providerTurnId !== undefined ? ` (${message.providerTurnId})` : '';
        lines.push(`\n[${message.role}${turn}] ${message.timestamp}`);
        lines.push(message.text);
    }
    if (output.truncated) {
        lines.push('\n[truncated; pass a lower limit or from_end:true for the tail]');
    }
    return lines.join('\n');
}

export function createSessionReadToolRegistration(
    options?: SessionToolsOptions,
): ToolRegistration<SessionReadInput, SessionReadOutput> {
    return {
        name: 'session_read',
        description:
            'Read messages and history from a durable mission-control session. Returns ordered user/assistant turns with timestamps. Read-only; no approval.',
        capabilityClasses: ['read'],
        parametersJsonSchema: sessionReadParametersJsonSchema,
        inputSchema: sessionReadInputSchema,
        outputSchema: sessionReadOutputSchema,
        outputLimit: { maxModelOutputChars: OUTPUT_LIMIT_CHARS },
        execute: async (input) => {
            const read = await readSessionProjection(input.session_id, options);
            if (read.kind !== 'found' || read.projection === undefined) {
                return { sessionId: input.session_id, found: false, messages: [], truncated: false };
            }
            const all = extractMessages(read.projection).map(redactMessage);
            const limit = input.limit ?? DEFAULT_MESSAGE_LIMIT;
            const slice = input.from_end ? all.slice(-limit) : all.slice(0, limit);
            return {
                sessionId: read.projection.sessionId,
                found: true,
                messages: slice,
                truncated: all.length > limit,
            };
        },
        toModelOutput: formatSessionReadModelOutput,
    };
}

function redactMessage(message: SessionMessageEntry): SessionMessageEntry {
    const text = redactSessionText(message.text);
    return { ...message, text };
}

// Kept for parity with the list tool's summary surface; not all fields are returned by read,
// but exposing the summary helper lets callers compose list+read consistently.
export { summarizeProjection };
