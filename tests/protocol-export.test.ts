import { describe, expect, it } from 'vitest';
import {
    AgentEventSchema,
    AgentSnapshotSchema,
    ModelProviderSelectionSchema,
    PermissionDecisionSchema,
    PermissionRequestSchema,
    PermissionStatusSchema,
    ProviderAuthFileSchema,
    ProviderCatalogEntrySchema,
    ProviderCredentialSchema,
    ProviderCredentialSummarySchema,
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
        expect(ProviderCatalogEntrySchema.shape.models).toBeDefined();
        expect(ProviderCredentialSchema.shape.apiKey).toBeDefined();
        expect(ProviderAuthFileSchema.shape.credentials).toBeDefined();
        expect(ProviderCredentialSummarySchema.shape.authenticated).toBeDefined();
    });
});
