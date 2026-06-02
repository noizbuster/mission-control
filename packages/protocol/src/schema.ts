import { z } from 'zod';

export const AGENT_EVENT_TYPES = [
    'session.started',
    'session.stopped',
    'task.started',
    'task.progress',
    'task.completed',
    'task.failed',
    'permission.requested',
    'native.warning',
    'log',
] as const;

export const SESSION_STATUSES = ['idle', 'running', 'stopped', 'failed'] as const;

export const NATIVE_SIDECAR_STATUSES = ['unknown', 'mock', 'native', 'unavailable'] as const;

export const PERMISSION_STATUSES = ['allow', 'deny'] as const;

export const AgentEventTypeSchema = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const PermissionStatusSchema = z.enum(PERMISSION_STATUSES);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const AgentMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const PermissionRequestSchema = z.object({
    id: z.string().min(1),
    action: z.string().min(1),
    reason: z.string().min(1),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionDecisionSchema = z.object({
    requestId: z.string().min(1),
    status: PermissionStatusSchema,
    reason: z.string().optional(),
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

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
});
export type SidecarTaskOutput = z.infer<typeof SidecarTaskOutputSchema>;

export const AgentEventSchema = z.object({
    type: AgentEventTypeSchema,
    timestamp: z.string().datetime(),
    sessionId: z.string().optional(),
    taskId: z.string().optional(),
    message: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    nativeSidecarStatus: z.enum(NATIVE_SIDECAR_STATUSES).optional(),
    permissionRequest: PermissionRequestSchema.optional(),
    permissionDecision: PermissionDecisionSchema.optional(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const AgentSessionSchema = z.object({
    id: z.string().min(1),
    status: z.enum(SESSION_STATUSES),
    startedAt: z.string().datetime(),
    stoppedAt: z.string().datetime().optional(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AgentSnapshotSchema = z.object({
    sessionId: z.string().min(1),
    status: z.enum(SESSION_STATUSES),
    startedAt: z.string().datetime(),
    stoppedAt: z.string().datetime().optional(),
    runningTaskCount: z.number().int().nonnegative(),
    completedTaskCount: z.number().int().nonnegative(),
    failedTaskCount: z.number().int().nonnegative(),
    lastEvent: AgentEventSchema.optional(),
    lastMessage: z.string().optional(),
    nativeSidecarStatus: z.enum(NATIVE_SIDECAR_STATUSES),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;
