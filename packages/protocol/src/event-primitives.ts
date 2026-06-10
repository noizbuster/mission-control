import { z } from 'zod';

export const EventIdSchema = z.string().min(1);
export type EventId = z.infer<typeof EventIdSchema>;

export const EventSequenceSchema = z.number().int().nonnegative();
export type EventSequence = z.infer<typeof EventSequenceSchema>;

export const AgentMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
