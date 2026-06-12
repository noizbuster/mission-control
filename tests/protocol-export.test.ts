import { describe, expect, it } from 'vitest';
import {
    AbgGraphSnapshotSchema,
    AbgGraphSpecSchema,
    AbgNodeModelOptionsSchema,
    AbgPolicyDecisionSchema,
    AbgSignalSchema,
    AbgToolOutcomeSnapshotSchema,
    AbgToolOutcomeStatusSchema,
    AgentEventEnvelopeSchema,
    AgentEventLogSchema,
    AgentEventSchema,
    AgentSnapshotSchema,
    ApprovalLifecycleStateSchema,
    ApprovalPolicyDecisionSchema,
    ApprovalRecordSchema,
    ApprovalSubjectSchema,
    DiffFileSchema,
    DiffHunkSchema,
    EventDurabilitySchema,
    ModelProviderSelectionSchema,
    ModelVariantEntrySchema,
    PermissionDecisionSchema,
    PermissionRequestSchema,
    PermissionStatusSchema,
    ProtocolErrorSchema,
    ProviderApiKeyCredentialSchema,
    ProviderAuthFileSchema,
    ProviderCapabilityStatusSchema,
    ProviderCatalogEntrySchema,
    ProviderCredentialFieldSchema,
    ProviderCredentialSchema,
    ProviderCredentialSummarySchema,
    ProviderExecutionCapabilitySchema,
    ProviderFieldsCredentialSchema,
    ProviderMessageSchema,
    ProviderRequestSchema,
    ProviderStreamChunkSchema,
    RedactionMetadataSchema,
    ReplayCursorSchema,
    SidecarCancelTaskCommandSchema,
    SidecarTaskCancelledResponseSchema,
    SidecarTaskFailedResponseSchema,
    SidecarTaskInputSchema,
    SidecarTaskOutputSchema,
    ToolCallSchema,
    ToolResultSchema,
    TranscriptDeliveryModeSchema,
    TranscriptEventMetadataSchema,
    TranscriptVisibilitySchema,
} from '../packages/protocol/src/index.js';

describe('protocol public exports', () => {
    it('exports schemas for public event session permission and sidecar boundaries', () => {
        expect(AgentEventSchema.shape.type).toBeDefined();
        expect(AgentEventEnvelopeSchema.shape.eventId).toBeDefined();
        expect(AgentEventLogSchema.parse([])).toEqual([]);
        expect(EventDurabilitySchema.parse('durable')).toBe('durable');
        expect(ReplayCursorSchema.shape.sequence).toBeDefined();
        expect(AgentSnapshotSchema.shape.sessionId).toBeDefined();
        expect(PermissionRequestSchema.shape.action).toBeDefined();
        expect(PermissionDecisionSchema.shape.status).toBeDefined();
        expect(PermissionStatusSchema.parse('deny')).toBe('deny');
        expect(ApprovalPolicyDecisionSchema.parse('requires_approval')).toBe('requires_approval');
        expect(ApprovalLifecycleStateSchema.parse('pending')).toBe('pending');
        expect(ApprovalSubjectSchema.shape.kind).toBeDefined();
        expect(ApprovalRecordSchema.shape.approvalId).toBeDefined();
        expect(SidecarCancelTaskCommandSchema.shape.payload).toBeDefined();
        expect(SidecarTaskInputSchema.shape.payload).toBeDefined();
        expect(SidecarTaskOutputSchema.shape.message).toBeDefined();
        expect(SidecarTaskFailedResponseSchema.shape.error).toBeDefined();
        expect(SidecarTaskCancelledResponseSchema.shape.reason).toBeDefined();
        expect(ModelProviderSelectionSchema.shape.providerID).toBeDefined();
        expect(ModelVariantEntrySchema.shape.id).toBeDefined();
        expect(ProviderCapabilityStatusSchema.parse('model-discovery-only')).toBe('model-discovery-only');
        expect(ProviderExecutionCapabilitySchema.shape.status).toBeDefined();
        expect(ProviderCatalogEntrySchema.shape.models).toBeDefined();
        expect(ProviderApiKeyCredentialSchema.shape.apiKey).toBeDefined();
        expect(ProviderCredentialFieldSchema.shape.secret).toBeDefined();
        expect(ProviderFieldsCredentialSchema.shape.fields).toBeDefined();
        expect(
            ProviderCredentialSchema.parse({
                providerID: 'local',
                type: 'apiKey',
                apiKey: 'local_test_key',
                createdAt: '2026-06-03T10:00:00.000Z',
                updatedAt: '2026-06-03T10:00:00.000Z',
            }).type,
        ).toBe('apiKey');
        expect(ProviderAuthFileSchema.shape.credentials).toBeDefined();
        expect(ProviderCredentialSummarySchema.shape.authenticated).toBeDefined();
        expect(ProviderRequestSchema.shape.requestId).toBeDefined();
        expect(
            ProviderStreamChunkSchema.parse({ kind: 'response_started', requestId: 'request_1', sequence: 0 }).kind,
        ).toBe('response_started');
        expect(
            AgentEventSchema.parse({
                type: 'task.progress',
                timestamp: '2026-06-08T10:00:00.000Z',
                providerStreamChunk: {
                    kind: 'text_delta',
                    requestId: 'request_1',
                    sequence: 1,
                    delta: 'hel',
                },
            }).providerStreamChunk?.kind,
        ).toBe('text_delta');
        expect(ProviderMessageSchema.shape.messageId).toBeDefined();
        expect(ToolCallSchema.shape.toolCallId).toBeDefined();
        expect(ToolResultSchema.shape.toolCallId).toBeDefined();
        expect(ProtocolErrorSchema.shape.code).toBeDefined();
        expect(RedactionMetadataSchema.shape.classification).toBeDefined();
        expect(DiffFileSchema.shape.filePath).toBeDefined();
        expect(DiffHunkSchema.shape.oldStart).toBeDefined();
        expect(TranscriptDeliveryModeSchema.parse('steer')).toBe('steer');
        expect(TranscriptVisibilitySchema.parse('model_visible')).toBe('model_visible');
        expect(TranscriptEventMetadataSchema.shape.messageId).toBeDefined();
    });

    it('exports ABG protocol schemas for graph authoring and runtime events', () => {
        expect(AbgGraphSpecSchema.shape.nodes).toBeDefined();
        expect(AbgNodeModelOptionsSchema.shape.providerID).toBeDefined();
        expect(AbgPolicyDecisionSchema.parse('requires_approval')).toBe('requires_approval');
        expect(AbgSignalSchema.parse({ type: 'started', nodeId: 'start' }).type).toBe('started');
        expect(AbgGraphSnapshotSchema.shape.graphId).toBeDefined();
        expect(AbgToolOutcomeStatusSchema.parse('completed')).toBe('completed');
        expect(AbgToolOutcomeSnapshotSchema.shape.toolId).toBeDefined();
    });
});
