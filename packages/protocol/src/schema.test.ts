import { describe, expect, it } from 'vitest';
import {
    AgentEventSchema,
    AgentEventTypeSchema,
    AgentSnapshotSchema,
    ModelProviderSelectionSchema,
    ProviderAuthFileSchema,
    ProviderCatalogEntrySchema,
    ProviderCredentialSchema,
    ProviderCredentialSummarySchema,
    SidecarTaskInputSchema,
    SidecarTaskOutputSchema,
} from './schema.js';

describe('protocol schemas', () => {
    it('exports schemas and types for required protocol events', () => {
        const event = AgentEventSchema.parse({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:00.000Z',
            taskId: 'task_1',
            message: 'demo completed',
        });

        expect(event.type).toBe('task.completed');
        expect(AgentEventTypeSchema.parse('native.warning')).toBe('native.warning');
    });

    it('rejects unknown event type', () => {
        const parsed = AgentEventSchema.safeParse({
            type: 'task.unknown',
            timestamp: '2026-06-02T10:00:00.000Z',
        });

        expect(parsed.success).toBe(false);
    });

    it('parses snapshots and sidecar task boundaries', () => {
        const snapshot = AgentSnapshotSchema.parse({
            sessionId: 'session_1',
            status: 'running',
            startedAt: '2026-06-02T10:00:00.000Z',
            runningTaskCount: 1,
            completedTaskCount: 0,
            failedTaskCount: 0,
            nativeSidecarStatus: 'mock',
        });
        const input = SidecarTaskInputSchema.parse({
            id: 'task_1',
            payload: {
                label: 'demo',
            },
        });
        const output = SidecarTaskOutputSchema.parse({
            id: 'task_1',
            message: 'completed by mock sidecar',
        });

        expect(snapshot.sessionId).toBe('session_1');
        expect(input.payload.label).toBe('demo');
        expect(output.message).toBe('completed by mock sidecar');
    });

    it('parses provider model selection and catalog entries', () => {
        const selection = ModelProviderSelectionSchema.parse({
            providerID: 'mock',
            modelID: 'mission-control-demo',
        });
        const provider = ProviderCatalogEntrySchema.parse({
            id: 'mock',
            name: 'Mock Provider',
            defaultModelID: 'mission-control-demo',
            authLabel: 'API key',
            models: [
                {
                    id: 'mission-control-demo',
                    name: 'Mission Control Demo',
                    status: 'active',
                },
            ],
        });

        expect(selection).toEqual({
            providerID: 'mock',
            modelID: 'mission-control-demo',
        });
        expect(provider.models[0]?.id).toBe('mission-control-demo');
    });

    it('keeps provider model metadata optional on existing events and snapshots', () => {
        const event = AgentEventSchema.parse({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:00.000Z',
            taskId: 'task_1',
            message: 'demo completed',
        });
        const snapshot = AgentSnapshotSchema.parse({
            sessionId: 'session_1',
            status: 'running',
            startedAt: '2026-06-02T10:00:00.000Z',
            runningTaskCount: 0,
            completedTaskCount: 0,
            failedTaskCount: 0,
            nativeSidecarStatus: 'mock',
        });

        expect(event.modelProviderSelection).toBeUndefined();
        expect(snapshot.modelProviderSelection).toBeUndefined();
    });

    it('parses provider credential records and auth file snapshots', () => {
        const credential = ProviderCredentialSchema.parse({
            providerID: 'mock',
            type: 'apiKey',
            apiKey: 'mc_test_key',
            createdAt: '2026-06-03T10:00:00.000Z',
            updatedAt: '2026-06-03T10:00:00.000Z',
        });
        const authFile = ProviderAuthFileSchema.parse({
            $schema: 'https://mission-control.local/auth.schema.json',
            default: {
                providerID: 'mock',
                modelID: 'mission-control-demo',
            },
            credentials: {
                mock: credential,
            },
        });
        const summary = ProviderCredentialSummarySchema.parse({
            providerID: 'mock',
            authenticated: true,
            maskedCredential: 'mc_t..._key',
        });

        expect(authFile.credentials['mock']?.apiKey).toBe('mc_test_key');
        expect(summary.maskedCredential).toBe('mc_t..._key');
        expect(
            ProviderCredentialSchema.safeParse({
                providerID: 'mock',
                type: 'apiKey',
                apiKey: '',
                createdAt: '2026-06-03T10:00:00.000Z',
                updatedAt: '2026-06-03T10:00:00.000Z',
            }).success,
        ).toBe(false);
    });
});
