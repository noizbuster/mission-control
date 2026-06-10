import type { AgentEvent, ProviderCredential } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import {
    createCredentialRedactions,
    createStaticProviderCredentialResolver,
    ProviderCredentialResolutionError,
    redactCredentialText,
    summarizeResolvedProviderCredential,
} from './credential-resolver.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('ProviderCredentialResolver', () => {
    it('resolves fake typed credentials without serializing the secret in summaries', async () => {
        // Given
        const credential = apiKeyCredential('openai', 'sk-test-secret');
        const resolver = createStaticProviderCredentialResolver([credential]);

        // When
        const resolved = await resolver.resolveRequiredProviderCredential({ providerID: 'openai' });
        const summary = summarizeResolvedProviderCredential(resolved);

        // Then
        expect(resolved).toMatchObject({ providerID: 'openai', type: 'apiKey', apiKey: 'sk-test-secret' });
        expect(JSON.stringify(summary)).not.toContain('sk-test-secret');
        expect(summary).toEqual({
            providerID: 'openai',
            authenticated: true,
            maskedCredential: 'sk-t...cret',
        });
    });

    it('redacts known and token-like credentials from events JSONL and error text', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_provider_redaction';
        const secret = 'sk-test-secret';
        const redactedMessage = redactCredentialText(`provider rejected ${secret}`, [secret]);
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            now: () => '2026-06-07T10:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        // When
        const redactions = createCredentialRedactions([secret]);
        await store.append(providerFailedEvent(sessionId, redactedMessage));
        await store.close();
        const jsonl = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
        const error = new ProviderCredentialResolutionError({
            providerID: 'openai',
            code: 'credential_unavailable',
            message: `credential sk-other-secret failed for ${secret}`,
            secrets: [secret],
        });

        // Then
        expect(redactedMessage).not.toContain(secret);
        expect(JSON.stringify(redactions)).not.toContain(secret);
        expect(jsonl).not.toContain(secret);
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain('sk-other-secret');
    });

    it('keeps raw credentials out of resolver missing-provider errors', async () => {
        // Given
        const resolver = createStaticProviderCredentialResolver([apiKeyCredential('openai', 'sk-test-secret')]);

        // When
        const missingCredential = resolver.resolveRequiredProviderCredential({ providerID: 'anthropic' });

        // Then
        await expect(missingCredential).rejects.toBeInstanceOf(ProviderCredentialResolutionError);
        await expect(missingCredential).rejects.not.toMatchObject({
            message: expect.stringContaining('sk-test-secret'),
        });
    });
});

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-provider-redaction-'));
    tempDirs.push(dataDir);
    return dataDir;
}

function apiKeyCredential(providerID: string, apiKey: string): ProviderCredential {
    return {
        providerID,
        type: 'apiKey',
        apiKey,
        createdAt: '2026-06-07T10:00:00.000Z',
        updatedAt: '2026-06-07T10:00:00.000Z',
    };
}

function providerFailedEvent(sessionId: string, message: string): AgentEvent {
    return {
        type: 'model.call.completed',
        timestamp: '2026-06-07T10:00:00.000Z',
        sessionId,
        message,
        modelProviderSelection: {
            providerID: 'openai',
            modelID: 'gpt-4.1',
        },
        abg: {
            graphId: 'graph_provider_redaction',
            nodeId: 'node_provider_redaction',
            model: {
                providerID: 'openai',
                modelID: 'gpt-4.1',
                variantID: 'default',
            },
        },
    };
}
