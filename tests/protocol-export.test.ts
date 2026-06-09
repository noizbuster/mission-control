import { describe, expect, it } from 'vitest';
import {
    AbgGraphSnapshotSchema,
    AbgGraphSpecSchema,
    AbgNodeModelOptionsSchema,
    AbgSignalSchema,
    AgentEventSchema,
    AgentSnapshotSchema,
    ModelProviderSelectionSchema,
    ModelVariantEntrySchema,
    PermissionDecisionSchema,
    PermissionRequestSchema,
    PermissionStatusSchema,
    ProviderApiKeyCredentialSchema,
    ProviderAuthFileSchema,
    ProviderCatalogEntrySchema,
    ProviderCredentialFieldSchema,
    ProviderCredentialSchema,
    ProviderCredentialSummarySchema,
    ProviderFieldsCredentialSchema,
    SidecarTaskInputSchema,
    SidecarTaskOutputSchema,
} from '../packages/protocol/src/index.js';

describe('protocol public exports', () => {
    it('exports schemas for public event session permission and sidecar boundaries', () => {
        expect(AgentEventSchema.shape.type).toBeDefined();
        expect(AgentSnapshotSchema.shape.sessionId).toBeDefined();
        expect(PermissionRequestSchema.shape.action).toBeDefined();
        expect(PermissionDecisionSchema.shape.status).toBeDefined();
        expect(PermissionStatusSchema.parse('deny')).toBe('deny');
        expect(SidecarTaskInputSchema.shape.payload).toBeDefined();
        expect(SidecarTaskOutputSchema.shape.message).toBeDefined();
        expect(ModelProviderSelectionSchema.shape.providerID).toBeDefined();
        expect(ModelVariantEntrySchema.shape.id).toBeDefined();
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
    });

    it('exports ABG protocol schemas for graph authoring and runtime events', () => {
        expect(AbgGraphSpecSchema.shape.nodes).toBeDefined();
        expect(AbgNodeModelOptionsSchema.shape.providerID).toBeDefined();
        expect(AbgSignalSchema.parse({ type: 'started', nodeId: 'start' }).type).toBe('started');
        expect(AbgGraphSnapshotSchema.shape.graphId).toBeDefined();
    });
});
