import { z } from 'zod';

/**
 * Session input delivery modes for the run-coordinator drain-lane (Task 1.5).
 *
 * `'steer'` coalesces a new input into the active run at the next safe provider-turn boundary;
 * `'queue'` opens a FIFO future run that executes after the active run drains. This is the same
 * vocabulary as {@linkcode import('./transcript.js').TRANSCRIPT_DELIVERY_MODES} (transcript event
 * metadata) but belongs to the session-input admission layer, so the constant is duplicated by
 * design — the two layers may diverge if a future delivery mode applies to only one.
 */
export const DELIVERY_MODES = ['steer', 'queue'] as const;
export const DeliverySchema = z.enum(DELIVERY_MODES);
export type Delivery = z.infer<typeof DeliverySchema>;

/**
 * Persisted/transmitted metadata describing how a session input was (or should be) admitted.
 * The {@linkcode mode} is the core decision; {@linkcode inputId} traces the input through the
 * durable event log.
 */
export const SessionInputDeliverySchema = z
    .object({
        mode: DeliverySchema,
        inputId: z.string().min(1).optional(),
    })
    .strict();
export type SessionInputDelivery = z.infer<typeof SessionInputDeliverySchema>;
