import { describe, expect, it } from 'vitest';
import {
    AbgGraphSnapshotSchema,
    AbgGraphSpecSchema,
    AbgNodeModelOptionsSchema,
    AbgOverlayPrefsSchema,
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
    BudgetConfigSchema,
    DiffFileSchema,
    DiffHunkSchema,
    EventDurabilitySchema,
    McpConfigEntrySchema,
    McpConfigSchema,
    McpProjectConfigSchema,
    MissionControlConfigSchema,
    ModelProviderSelectionSchema,
    ModelVariantEntrySchema,
    PERMISSION_KINDS,
    PermissionDecisionSchema,
    PermissionKindSchema,
    PermissionReplySchema,
    PermissionRequestSchema,
    PermissionRuleDecisionSchema,
    PermissionRuleSchema,
    PermissionStatusSchema,
    PricingEntrySchema,
    PricingTableSchema,
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
    SESSION_ARCHIVE_FILE_KIND,
    SESSION_ARCHIVE_FILE_VERSION,
    SESSION_ARCHIVE_SCHEMA_VERSION,
    SessionArchiveChecksumSchema,
    SessionArchiveFileSchema,
    SessionArchiveManifestSchema,
    SessionTreeEventMetadataSchema,
    SessionTreeEventTypeSchema,
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
        expect(SESSION_ARCHIVE_SCHEMA_VERSION).toBe(1);
        expect(SESSION_ARCHIVE_FILE_KIND).toBe('mission-control.session-archive');
        expect(SESSION_ARCHIVE_FILE_VERSION).toBe(1);
        expect(SessionTreeEventTypeSchema.parse('session.tree.entry')).toBe('session.tree.entry');
        expect(
            SessionTreeEventMetadataSchema.parse({
                kind: 'metadata',
                cwd: '/workspace/mission-control',
                trustedRoot: '/workspace/mission-control',
                workspaceTrust: 'trusted',
            }),
        ).toEqual({
            kind: 'metadata',
            cwd: '/workspace/mission-control',
            trustedRoot: '/workspace/mission-control',
            workspaceTrust: 'trusted',
        });
        expect(SessionArchiveManifestSchema.shape.trustedRoot).toBeDefined();
        expect(SessionArchiveChecksumSchema.shape.value).toBeDefined();
        expect(SessionArchiveFileSchema.shape.eventsJsonl).toBeDefined();
        expect(AgentSnapshotSchema.shape.sessionId).toBeDefined();
        expect(PermissionRequestSchema.shape.action).toBeDefined();
        expect(PermissionDecisionSchema.shape.status).toBeDefined();
        expect(PermissionReplySchema.shape.reply).toBeDefined();
        expect(PermissionRuleSchema.shape.pattern).toBeDefined();
        expect(PermissionRuleDecisionSchema.parse('once')).toBe('once');
        expect(PermissionStatusSchema.parse('deny')).toBe('deny');
        // Lock the network/subagent kind cascade: admitted by the enum + strict schemas, unknown kinds still rejected.
        expect(PERMISSION_KINDS).toContain('network');
        expect(PERMISSION_KINDS).toContain('subagent');
        expect(PermissionKindSchema.parse('network')).toBe('network');
        expect(PermissionKindSchema.parse('subagent')).toBe('subagent');
        expect(PermissionRuleSchema.parse({ permission: 'network', pattern: '*', decision: 'ask' }).permission).toBe(
            'network',
        );
        expect(() => PermissionKindSchema.parse('remote-exec')).toThrow();
        expect(McpConfigEntrySchema.parse({ type: 'local', command: ['npx'] }).type).toBe('local');
        expect(McpConfigEntrySchema.parse({ type: 'remote', url: 'https://example.test/mcp' }).type).toBe('remote');
        expect(() => McpConfigEntrySchema.parse({ type: 'remote', url: 'nope' })).toThrow();
        expect(McpConfigSchema.parse({})).toEqual({});
        expect(MissionControlConfigSchema.shape.mcp).toBeDefined();
        expect(McpProjectConfigSchema.shape.mcpServers).toBeDefined();
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
        expect(PricingEntrySchema.shape.providerID).toBeDefined();
        expect(PricingTableSchema.element).toBeDefined();
        expect(BudgetConfigSchema.shape.budgetCents).toBeDefined();
        expect(AbgOverlayPrefsSchema.shape.activeTabIndex).toBeDefined();
        expect(AbgOverlayPrefsSchema.parse({}).activeTabIndex).toBe(0);
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
