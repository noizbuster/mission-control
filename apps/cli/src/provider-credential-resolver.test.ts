import type { ProviderAuthFile } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createCliProviderCredentialResolver } from './provider-credential-resolver.js';
import { PlainRenderer } from './ui/renderers.js';

describe('CLI provider credential resolver', () => {
    it('maps auth-store credentials to a fake core resolver without leaking raw keys to CLI output', async () => {
        // Given
        const secret = 'sk-test-secret';
        const authFile = providerAuthFile(secret);
        const resolver = createCliProviderCredentialResolver({
            readAuthFile: async () => authFile,
        });
        const renderer = new PlainRenderer();

        // When
        const credential = await resolver.resolveProviderCredential({ providerID: 'openai' });
        renderer.render({
            type: 'model.call.completed',
            timestamp: '2026-06-07T10:00:00.000Z',
            sessionId: 'session_cli_provider',
            message: resolver.redactForOutput(`provider accepted ${secret}`),
            modelProviderSelection: {
                providerID: 'openai',
                modelID: 'gpt-4.1',
            },
        });

        // Then
        expect(credential).toMatchObject({ providerID: 'openai', type: 'apiKey', apiKey: secret });
        expect(renderer.getOutput()).not.toContain(secret);
        expect(JSON.stringify(await resolver.summarizeProviderCredential({ providerID: 'openai' }))).not.toContain(
            secret,
        );
    });
});

function providerAuthFile(secret: string): ProviderAuthFile {
    return {
        $schema: 'https://mission-control.local/auth.schema.json',
        credentials: {
            openai: {
                providerID: 'openai',
                type: 'apiKey',
                apiKey: secret,
                createdAt: '2026-06-07T10:00:00.000Z',
                updatedAt: '2026-06-07T10:00:00.000Z',
            },
        },
    };
}
