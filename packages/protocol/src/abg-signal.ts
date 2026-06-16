import { z } from 'zod';

export const ABG_SIGNAL_TYPES = [
    'started',
    'progress',
    'emit',
    'select',
    'transition',
    'spawn',
    'cancel',
    'success',
    'failure',
    'cancelled',
    'escalate',
    'fallback',
] as const;

export const AbgSignalTypeSchema = z.enum(ABG_SIGNAL_TYPES);
export type AbgSignalType = z.infer<typeof AbgSignalTypeSchema>;

export const AbgEmbeddedEventSchema = z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    source: z.string().min(1),
    timestamp: z.string().datetime(),
    payload: z.unknown().optional(),
    causationId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
});
export type AbgEmbeddedEvent = z.infer<typeof AbgEmbeddedEventSchema>;

const AbgSignalBaseSchema = z.object({
    graphId: z.string().min(1).optional(),
    nodeId: z.string().min(1),
});

export const AbgSignalSchema = z.discriminatedUnion('type', [
    AbgSignalBaseSchema.extend({ type: z.literal('started') }),
    AbgSignalBaseSchema.extend({
        type: z.literal('progress'),
        data: z.unknown().optional(),
        message: z.string().optional(),
    }),
    AbgSignalBaseSchema.extend({ type: z.literal('emit'), event: AbgEmbeddedEventSchema }),
    AbgSignalBaseSchema.extend({
        type: z.literal('select'),
        target: z.string().min(1),
        reason: z.string().optional(),
    }),
    AbgSignalBaseSchema.extend({
        type: z.literal('transition'),
        from: z.string().min(1),
        to: z.string().min(1),
    }),
    AbgSignalBaseSchema.extend({ type: z.literal('spawn'), actor: z.string().min(1), input: z.unknown().optional() }),
    AbgSignalBaseSchema.extend({
        type: z.literal('cancel'),
        target: z.string().min(1),
        reason: z.string().optional(),
    }),
    AbgSignalBaseSchema.extend({ type: z.literal('success'), result: z.unknown().optional() }),
    AbgSignalBaseSchema.extend({ type: z.literal('failure'), error: z.unknown() }),
    AbgSignalBaseSchema.extend({ type: z.literal('cancelled'), reason: z.string().optional() }),
    AbgSignalBaseSchema.extend({
        type: z.literal('escalate'),
        target: z.string().min(1).optional(),
        reason: z.string().min(1).optional(),
    }),
    AbgSignalBaseSchema.extend({
        type: z.literal('fallback'),
        reason: z.string().min(1).optional(),
    }),
]);
export type AbgSignal = z.infer<typeof AbgSignalSchema>;
