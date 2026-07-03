import { z } from 'zod';

export const NATIVE_SIDECAR_STATUSES = ['unknown', 'mock', 'native', 'unavailable'] as const;
export const NativeSidecarStatusSchema = z.enum(NATIVE_SIDECAR_STATUSES);
export type NativeSidecarStatus = z.infer<typeof NativeSidecarStatusSchema>;

export const SIDECAR_PROTOCOL_VERSION = 1 as const;
export const SIDECAR_PROTOCOL_V2_VERSION = 2 as const;
export const SIDECAR_PROTOCOL_V3_VERSION = 3 as const;
export const SIDECAR_PROTOCOL_VERSIONS = [
    SIDECAR_PROTOCOL_VERSION,
    SIDECAR_PROTOCOL_V2_VERSION,
    SIDECAR_PROTOCOL_V3_VERSION,
] as const;
export const SidecarProtocolVersionSchema = z.union([
    z.literal(SIDECAR_PROTOCOL_VERSION),
    z.literal(SIDECAR_PROTOCOL_V2_VERSION),
    z.literal(SIDECAR_PROTOCOL_V3_VERSION),
]);
export type SidecarProtocolVersion = z.infer<typeof SidecarProtocolVersionSchema>;

export const SIDECAR_V1_CAPABILITIES = ['task.run'] as const;
export const SIDECAR_CAPABILITIES = ['task.run', 'task.cancel'] as const;
export const SIDECAR_V3_CAPABILITIES = [
    'task.run',
    'task.cancel',
    'shell.session',
    'pty.alloc',
    'iso.resolve',
] as const;
const SidecarV1CapabilitySchema = z.enum(SIDECAR_V1_CAPABILITIES);
export const SidecarCapabilitySchema = z.enum(SIDECAR_CAPABILITIES);
const SidecarV3CapabilitySchema = z.enum(SIDECAR_V3_CAPABILITIES);
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

const SidecarHandshakeV3ResponseSchema = z.object({
    type: z.literal('handshake_completed'),
    id: z.string().min(1),
    protocolVersion: z.literal(SIDECAR_PROTOCOL_V3_VERSION),
    capabilities: z.array(SidecarV3CapabilitySchema).min(1),
});

export const SidecarHandshakeResponseSchema = z.discriminatedUnion('protocolVersion', [
    SidecarHandshakeV1ResponseSchema,
    SidecarHandshakeV2ResponseSchema,
    SidecarHandshakeV3ResponseSchema,
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

// ---------------------------------------------------------------------------
// Protocol v3: stateful streaming capabilities (shell.session / pty.alloc / iso.resolve)
//
// SidecarStreamFrame is the SINGLE load-bearing streaming envelope. Both shell
// sessions (task 16) and pty allocations (task 17) emit their output as a
// sequence of SidecarStreamFrames. One SidecarStreamOpenRequest produces N
// frames with strictly-increasing seq (0..N-1); the final frame carries
// end:true. An optional SidecarStreamCloseCommand stops the stream mid-flight.
// Error frames SHOULD set end:true (terminal).
// ---------------------------------------------------------------------------

/**
 * Load-bearing streaming envelope. The single frame both shell sessions and
 * pty allocations emit over the sidecar wire.
 */
export const SidecarStreamFrameSchema = z.object({
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    payload: z.string(),
    end: z.boolean(),
    error: z.string().optional(),
});
export type SidecarStreamFrame = z.infer<typeof SidecarStreamFrameSchema>;

export const SidecarStreamKindSchema = z.enum(['shell', 'pty']);
export type SidecarStreamKind = z.infer<typeof SidecarStreamKindSchema>;

export const SidecarStreamOpenRequestSchema = z.object({
    type: z.literal('stream_open'),
    id: z.string().min(1),
    payload: z.object({
        sessionId: z.string().min(1),
        kind: SidecarStreamKindSchema,
        command: z.string().optional(),
        cwd: z.string().optional(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
        // shell.session containment contract: the TS-vetted env (allowlisted +
        // redacted) is forwarded here so the brush session starts with a
        // controlled environment instead of inheriting the sidecar process env.
        env: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
    }),
});
export type SidecarStreamOpenRequest = z.infer<typeof SidecarStreamOpenRequestSchema>;

export const SidecarStreamCloseCommandSchema = z.object({
    type: z.literal('stream_close'),
    id: z.string().min(1),
    payload: z.object({
        sessionId: z.string().min(1),
        reason: z.string().min(1).optional(),
    }),
});
export type SidecarStreamCloseCommand = z.infer<typeof SidecarStreamCloseCommandSchema>;

/**
 * Wire response carrying a SidecarStreamFrame. Kept separate from
 * SidecarWireResponseSchema so the existing task-lifecycle parser's
 * exhaustive switch (assertNever) is unaffected.
 */
export const SidecarStreamFrameResponseSchema = SidecarStreamFrameSchema.extend({
    type: z.literal('stream_frame'),
});
export type SidecarStreamFrameResponse = z.infer<typeof SidecarStreamFrameResponseSchema>;

export const SidecarShellRunRequestSchema = z.object({
    sessionId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().optional(),
});
export type SidecarShellRunRequest = z.infer<typeof SidecarShellRunRequestSchema>;

export const SidecarShellOutputSchema = z.object({
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
});
export type SidecarShellOutput = z.infer<typeof SidecarShellOutputSchema>;

export const SidecarPtyAllocRequestSchema = z.object({
    sessionId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    command: z.string().optional(),
});
export type SidecarPtyAllocRequest = z.infer<typeof SidecarPtyAllocRequestSchema>;

export const SidecarIsoResolveRequestSchema = z.object({
    type: z.literal('iso_resolve'),
    id: z.string().min(1),
    payload: z.object({
        target: z.string().min(1),
        method: z.string().min(1).optional(),
    }),
});
export type SidecarIsoResolveRequest = z.infer<typeof SidecarIsoResolveRequestSchema>;

export const SidecarIsoResolveResponseSchema = z.object({
    type: z.literal('iso_resolved'),
    id: z.string().min(1),
    payload: z.object({
        resolved: z.string(),
        method: z.string().optional(),
    }),
});
export type SidecarIsoResolveResponse = z.infer<typeof SidecarIsoResolveResponseSchema>;

export const SidecarIsoDiffRequestSchema = z.object({
    type: z.literal('iso_diff'),
    id: z.string().min(1),
    payload: z.object({
        target: z.string().min(1),
        baseline: z.string(),
        current: z.string(),
    }),
});
export type SidecarIsoDiffRequest = z.infer<typeof SidecarIsoDiffRequestSchema>;

export const SidecarIsoDiffResponseSchema = z.object({
    type: z.literal('iso_diffed'),
    id: z.string().min(1),
    payload: z.object({
        diff: z.string(),
        identical: z.boolean(),
    }),
});
export type SidecarIsoDiffResponse = z.infer<typeof SidecarIsoDiffResponseSchema>;

/**
 * Validates a replayed sequence of SidecarStreamFrames for stream-level
 * invariants that a single-frame schema cannot enforce:
 *
 * - seq must be strictly increasing (rejects duplicate or out-of-order seq)
 * - no frame may follow a terminal end:true frame
 *
 * Individual frames should be validated with SidecarStreamFrameSchema first.
 */
export function validateSidecarStreamFrames(frames: readonly SidecarStreamFrame[]): SidecarStreamFrame[] {
    let ended = false;
    let lastSeq = -1;
    for (const frame of frames) {
        if (ended) {
            throw new Error(
                `sidecar stream received frame after terminal end:true (sessionId=${frame.sessionId}, seq=${String(frame.seq)})`,
            );
        }
        if (frame.seq <= lastSeq) {
            throw new Error(
                `sidecar stream seq must be strictly increasing: got ${String(frame.seq)} after ${String(lastSeq)} (sessionId=${frame.sessionId})`,
            );
        }
        lastSeq = frame.seq;
        if (frame.end) {
            ended = true;
        }
    }
    return [...frames];
}
