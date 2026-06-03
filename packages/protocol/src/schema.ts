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

export const MODEL_CATALOG_STATUSES = ['active', 'deprecated'] as const;

export const AgentEventTypeSchema = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const PermissionStatusSchema = z.enum(PERMISSION_STATUSES);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const ModelCatalogStatusSchema = z.enum(MODEL_CATALOG_STATUSES);
export type ModelCatalogStatus = z.infer<typeof ModelCatalogStatusSchema>;

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

export const ModelProviderSelectionSchema = z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
});
export type ModelProviderSelection = z.infer<typeof ModelProviderSelectionSchema>;

export const ProviderCredentialSchema = z.object({
    providerID: z.string().min(1),
    type: z.literal('apiKey'),
    apiKey: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type ProviderCredential = z.infer<typeof ProviderCredentialSchema>;

export const ProviderAuthFileSchema = z.object({
    $schema: z.string().url(),
    default: ModelProviderSelectionSchema.optional(),
    credentials: z.record(z.string().min(1), ProviderCredentialSchema),
});
export type ProviderAuthFile = z.infer<typeof ProviderAuthFileSchema>;

export const ProviderCredentialSummarySchema = z.object({
    providerID: z.string().min(1),
    authenticated: z.boolean(),
    maskedCredential: z.string().optional(),
});
export type ProviderCredentialSummary = z.infer<typeof ProviderCredentialSummarySchema>;

export const ModelCatalogEntrySchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: ModelCatalogStatusSchema.default('active'),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const ProviderCatalogEntrySchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    defaultModelID: z.string().min(1),
    authLabel: z.string().min(1),
    models: z.array(ModelCatalogEntrySchema).min(1),
});
export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>;

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
    modelProviderSelection: ModelProviderSelectionSchema.optional(),
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
    modelProviderSelection: ModelProviderSelectionSchema.optional(),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;
