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
    CategoryCatalogSchema,
    CategorySchema,
    DELIVERY_MODES,
    DeliverySchema,
    DiffFileSchema,
    DiffHunkSchema,
    EventDurabilitySchema,
    McpConfigEntrySchema,
    McpConfigSchema,
    McpProjectConfigSchema,
    MissionControlConfigSchema,
    ModeDeclarationSchema,
    ModelProviderSelectionSchema,
    ModelVariantEntrySchema,
    ModeSchema,
    PERMISSION_KINDS,
    PermissionDecisionSchema,
    PermissionKindSchema,
    PermissionReplySchema,
    PermissionRequestSchema,
    PermissionRuleDecisionSchema,
    PermissionRuleSchema,
    PermissionStatusSchema,
    PLUGIN_DISCOVERY_DIAGNOSTIC_SEVERITIES,
    PluginContextSourceSchema,
    PluginDescriptorSchema,
    PluginDiscoveryDiagnosticSchema,
    PluginLspServerSchema,
    PluginManifestSchema,
    PluginNodeDefinitionSchema,
    PluginSubAgentSchema,
    PluginToolDefinitionSchema,
    POLICY_EFFECTS,
    PolicyEffectRuleSchema,
    PolicyEffectRuleSetSchema,
    PolicyEffectSchema,
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
    SessionInputDeliverySchema,
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
    WorkflowDiscoveryDiagnosticSchema,
    WorkflowSpecSchema,
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

    it('exports workflow system schemas (Category, Mode, Delivery, PolicyEffectRule, WorkflowSpec)', () => {
        // Category + catalog
        expect(CategorySchema.shape.id).toBeDefined();
        expect(CategorySchema.shape.permissions).toBeDefined();
        expect(CategorySchema.parse({ id: 'deep', permissions: ['read', 'edit', 'bash'] }).permissions).toEqual([
            'read',
            'edit',
            'bash',
        ]);
        expect(() => CategorySchema.parse({ id: 'x', permissions: ['bogus'] })).toThrow();
        expect(CategoryCatalogSchema.parse({}).categories).toEqual([]);

        // Mode + declaration
        expect(ModeSchema.shape.id).toBeDefined();
        expect(ModeSchema.shape.policies).toBeDefined();
        expect(ModeSchema.parse({ id: 'autopilot' }).policies).toEqual([]);
        expect(ModeDeclarationSchema.parse({ modeId: 'autopilot' }).active).toBe(true);
        expect(ModeDeclarationSchema.parse({ modeId: 'autopilot', active: false }).active).toBe(false);

        // Delivery
        expect(DELIVERY_MODES).toEqual(['steer', 'queue']);
        expect(DeliverySchema.parse('steer')).toBe('steer');
        expect(DeliverySchema.parse('queue')).toBe('queue');
        expect(() => DeliverySchema.parse('interrupt')).toThrow();
        expect(SessionInputDeliverySchema.parse({ mode: 'queue' }).mode).toBe('queue');

        // PolicyEffect rules (distinct from workspace PermissionRuleSchema)
        expect(POLICY_EFFECTS).toEqual(['allow', 'deny', 'ask']);
        expect(PolicyEffectSchema.parse('allow')).toBe('allow');
        expect(PolicyEffectSchema.parse('ask')).toBe('ask');
        expect(PolicyEffectRuleSchema.shape.effect).toBeDefined();
        expect(PolicyEffectRuleSchema.parse({ action: 'write', resource: '**', effect: 'deny' }).effect).toBe('deny');
        expect(() => PolicyEffectRuleSchema.parse({ action: 'write', resource: '**', effect: 'maybe' })).toThrow();
        expect(PolicyEffectRuleSetSchema.parse({}).rules).toEqual([]);
        // Lock the name-collision avoidance: existing PermissionRuleSchema keeps its shape.
        expect(PermissionRuleSchema.shape.permission).toBeDefined();
        expect(PermissionRuleSchema.shape.pattern).toBeDefined();

        // WorkflowSpec wraps AbgGraphSpecSchema
        expect(WorkflowSpecSchema.shape.graph).toBeDefined();
        expect(WorkflowSpecSchema.shape.name).toBeDefined();
        expect(
            WorkflowSpecSchema.parse({
                name: 'default',
                graph: {
                    id: 'wf-1',
                    entryNodeId: 'n1',
                    nodes: [{ id: 'n1', kind: 'llm' }],
                },
            }).graph.id,
        ).toBe('wf-1');
        expect(() =>
            WorkflowSpecSchema.parse({
                name: 'bad',
                graph: { id: 'wf-1', entryNodeId: 'missing', nodes: [{ id: 'n1', kind: 'llm' }] },
            }),
        ).toThrow();

        // Workflow discovery diagnostic
        expect(WorkflowDiscoveryDiagnosticSchema.shape.severity).toBeDefined();
        expect(
            WorkflowDiscoveryDiagnosticSchema.parse({
                workflowName: 'planner',
                severity: 'warning',
                code: 'invalid_mode',
                message: 'unknown mode id',
            }).severity,
        ).toBe('warning');
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

    it('exports plugin system schemas (PluginManifest, PluginDescriptor, PluginDiscoveryDiagnostic, PluginLspServer, PluginToolDefinition, PluginNodeDefinition, PluginContextSource, PluginSubAgent)', () => {
        expect(PLUGIN_DISCOVERY_DIAGNOSTIC_SEVERITIES).toEqual(['error', 'warning', 'info']);
        expect(
            PluginManifestSchema.parse({
                name: 'my-plugin',
                version: '1.0.0',
            }).provides.skills,
        ).toBe(false);
        expect(
            PluginManifestSchema.parse({
                name: 'p',
                version: '1.0.0',
                provides: { skills: true, mcp: true },
            }).provides.mcp,
        ).toBe(true);
        expect(() => PluginManifestSchema.parse({ version: '1.0.0' })).toThrow();
        expect(PluginDescriptorSchema.shape.rootPath).toBeDefined();
        expect(
            PluginDiscoveryDiagnosticSchema.parse({
                pluginName: 'broken',
                severity: 'error',
                code: 'validation_error',
                message: 'bad manifest',
            }).severity,
        ).toBe('error');
        expect(
            PluginLspServerSchema.parse({
                name: 'tsserver',
                language: 'typescript',
                command: 'tsserver',
            }).timeoutMs,
        ).toBe(30000);
        expect(
            PluginToolDefinitionSchema.parse({
                name: 'my-tool',
                description: 'a tool',
                inputSchema: {},
            }).capability,
        ).toBe('read');
        expect(PluginNodeDefinitionSchema.parse({ kind: 'my-node' }).runner).toBe('llm');
        expect(
            PluginContextSourceSchema.parse({
                key: 'docs',
                description: 'docs source',
                baselineFile: 'docs/baseline.md',
            }).baselineFile,
        ).toBe('docs/baseline.md');
        expect(
            PluginSubAgentSchema.parse({
                id: 'agent-1',
                name: 'Agent One',
                systemPrompt: 'You are agent one.',
            }).tools,
        ).toEqual([]);
    });
});
