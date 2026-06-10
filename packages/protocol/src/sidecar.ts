import { z } from 'zod';

export const NATIVE_SIDECAR_STATUSES = ['unknown', 'mock', 'native', 'unavailable'] as const;
export const NativeSidecarStatusSchema = z.enum(NATIVE_SIDECAR_STATUSES);
export type NativeSidecarStatus = z.infer<typeof NativeSidecarStatusSchema>;

export const SIDECAR_PROTOCOL_VERSION = 1 as const;
export const SIDECAR_CAPABILITIES = ['task.run'] as const;
export const SidecarCapabilitySchema = z.enum(SIDECAR_CAPABILITIES);
export type SidecarCapability = z.infer<typeof SidecarCapabilitySchema>;

export const SidecarHandshakeCommandSchema = z.object({
    type: z.literal('handshake'),
    id: z.string().min(1),
    payload: z.object({
        protocolVersion: z.literal(SIDECAR_PROTOCOL_VERSION),
        clientName: z.string().min(1),
    }),
});
export type SidecarHandshakeCommand = z.infer<typeof SidecarHandshakeCommandSchema>;

export const SidecarHandshakeResponseSchema = z.object({
    type: z.literal('handshake_completed'),
    id: z.string().min(1),
    protocolVersion: z.literal(SIDECAR_PROTOCOL_VERSION),
    capabilities: z.array(SidecarCapabilitySchema).min(1),
});
export type SidecarHandshakeResponse = z.infer<typeof SidecarHandshakeResponseSchema>;

export const SidecarTaskInputSchema = z.object({
    id: z.string().min(1),
    payload: z.object({
        label: z.string().min(1),
    }),
});
export type SidecarTaskInput = z.infer<typeof SidecarTaskInputSchema>;

export const SidecarTaskOutputSchema = z.object({
    id: z.string().min(1),
    message: z.string().min(1),
    nativeSidecarStatus: NativeSidecarStatusSchema.optional(),
});
export type SidecarTaskOutput = z.infer<typeof SidecarTaskOutputSchema>;

export const SidecarTaskProgressResponseSchema = z.object({
    type: z.literal('task_progress'),
    id: z.string().min(1),
    progress: z.number().min(0).max(1),
});

export const SidecarTaskCompletedResponseSchema = z.object({
    type: z.literal('task_completed'),
    id: z.string().min(1),
    result: z.object({
        message: z.string().min(1),
    }),
});

export const SidecarWireResponseSchema = z.discriminatedUnion('type', [
    SidecarHandshakeResponseSchema,
    SidecarTaskProgressResponseSchema,
    SidecarTaskCompletedResponseSchema,
]);
export type SidecarWireResponse = z.infer<typeof SidecarWireResponseSchema>;
