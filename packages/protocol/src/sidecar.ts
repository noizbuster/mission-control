import { z } from 'zod';

export const NATIVE_SIDECAR_STATUSES = ['unknown', 'mock', 'native', 'unavailable'] as const;
export const NativeSidecarStatusSchema = z.enum(NATIVE_SIDECAR_STATUSES);
export type NativeSidecarStatus = z.infer<typeof NativeSidecarStatusSchema>;

export const SIDECAR_PROTOCOL_VERSION = 1 as const;
export const SIDECAR_PROTOCOL_V2_VERSION = 2 as const;
export const SIDECAR_PROTOCOL_VERSIONS = [SIDECAR_PROTOCOL_VERSION, SIDECAR_PROTOCOL_V2_VERSION] as const;
export const SidecarProtocolVersionSchema = z.union([
    z.literal(SIDECAR_PROTOCOL_VERSION),
    z.literal(SIDECAR_PROTOCOL_V2_VERSION),
]);
export type SidecarProtocolVersion = z.infer<typeof SidecarProtocolVersionSchema>;

export const SIDECAR_V1_CAPABILITIES = ['task.run'] as const;
export const SIDECAR_CAPABILITIES = ['task.run', 'task.cancel'] as const;
const SidecarV1CapabilitySchema = z.enum(SIDECAR_V1_CAPABILITIES);
export const SidecarCapabilitySchema = z.enum(SIDECAR_CAPABILITIES);
export type SidecarCapability = z.infer<typeof SidecarCapabilitySchema>;

export const SidecarHandshakeCommandSchema = z.object({
    type: z.literal('handshake'),
    id: z.string().min(1),
    payload: z.object({
        protocolVersion: SidecarProtocolVersionSchema,
        clientName: z.string().min(1),
        requestedCapabilities: z.array(SidecarCapabilitySchema).optional(),
    }),
});
export type SidecarHandshakeCommand = z.infer<typeof SidecarHandshakeCommandSchema>;

const SidecarHandshakeV1ResponseSchema = z.object({
    type: z.literal('handshake_completed'),
    id: z.string().min(1),
    protocolVersion: z.literal(SIDECAR_PROTOCOL_VERSION),
    capabilities: z.array(SidecarV1CapabilitySchema).min(1),
});

const SidecarHandshakeV2ResponseSchema = z.object({
    type: z.literal('handshake_completed'),
    id: z.string().min(1),
    protocolVersion: z.literal(SIDECAR_PROTOCOL_V2_VERSION),
    capabilities: z.array(SidecarCapabilitySchema).min(1),
});

export const SidecarHandshakeResponseSchema = z.discriminatedUnion('protocolVersion', [
    SidecarHandshakeV1ResponseSchema,
    SidecarHandshakeV2ResponseSchema,
]);
export type SidecarHandshakeResponse = z.infer<typeof SidecarHandshakeResponseSchema>;

export const SidecarCancelTaskCommandSchema = z.object({
    type: z.literal('cancel_task'),
    id: z.string().min(1),
    payload: z.object({
        taskId: z.string().min(1),
        reason: z.string().min(1).optional(),
    }),
});
export type SidecarCancelTaskCommand = z.infer<typeof SidecarCancelTaskCommandSchema>;

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

export const SidecarTaskFailedResponseSchema = z.object({
    type: z.literal('task_failed'),
    id: z.string().min(1),
    error: z.object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean().optional(),
    }),
});
export type SidecarTaskFailedResponse = z.infer<typeof SidecarTaskFailedResponseSchema>;

export const SidecarTaskCancelledResponseSchema = z.object({
    type: z.literal('task_cancelled'),
    id: z.string().min(1),
    reason: z.string().min(1),
});
export type SidecarTaskCancelledResponse = z.infer<typeof SidecarTaskCancelledResponseSchema>;

export const SidecarWireResponseSchema = z.union([
    SidecarHandshakeResponseSchema,
    SidecarTaskProgressResponseSchema,
    SidecarTaskCompletedResponseSchema,
    SidecarTaskFailedResponseSchema,
    SidecarTaskCancelledResponseSchema,
]);
export type SidecarWireResponse = z.infer<typeof SidecarWireResponseSchema>;
