import { defaultModelProviderSelection } from '@mission-control/config';
import { describe, expect, it } from 'vitest';
import { createMockDesktopAgentClient } from './agent-client.js';
import { DesktopCommandReceiptSchema } from './desktop-command-schemas.js';
import { redactDisplayText } from './redaction.js';

describe('desktop agent client', () => {
    it('mock desktop client emits demo event log', async () => {
        const client = createMockDesktopAgentClient();
        const session = await client.startDemoSession();
        const events = await client.runDemoTask(session.id, defaultModelProviderSelection);

        expect(session.id).toMatch(/^session_/);
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining([
                'session.started',
                'task.started',
                'graph.started',
                'node.completed',
                'task.completed',
            ]),
        );
    });

    it('mock desktop client emits selected provider and model metadata', async () => {
        const client = createMockDesktopAgentClient();
        const session = await client.startDemoSession();
        const events = await client.runDemoTask(session.id, {
            providerID: 'local',
            modelID: 'local-echo',
        });

        expect(events.map((event) => event.modelProviderSelection)).toEqual(
            events.map(() => ({
                providerID: 'local',
                modelID: 'local-echo',
            })),
        );
    });

    it('mock desktop client preserves generated provider and model metadata', async () => {
        const client = createMockDesktopAgentClient();
        const session = await client.startDemoSession();
        const events = await client.runDemoTask(session.id, {
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
        });

        expect(events.find((event) => event.type === 'task.completed')?.modelProviderSelection).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
        });
    });

    it('mock desktop client emits graph metadata for the demo event log', async () => {
        const client = createMockDesktopAgentClient();
        const session = await client.startDemoSession();
        const events = await client.runDemoTask(session.id, {
            providerID: 'local',
            modelID: 'local-echo',
        });

        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['graph.started', 'node.completed', 'graph.completed']),
        );
        expect(events.find((event) => event.type === 'node.completed')?.abg).toMatchObject({
            graphId: 'desktop-demo-graph',
            nodeId: 'desktop-answer',
            signalType: 'success',
            model: {
                providerID: 'local',
                modelID: 'local-echo',
                variantID: 'default',
            },
        });
    });

    it('returns provider credential summaries for desktop', async () => {
        const client = createMockDesktopAgentClient();
        const beforeSave = await client.listProviderCredentials();
        const saved = await client.saveProviderCredential({
            providerID: 'openai',
            modelID: 'gpt-4.1',
            apiKey: 'sk-test-secret',
        });
        const afterSave = await client.listProviderCredentials();

        expect(beforeSave).toEqual([]);
        expect(saved).toEqual({
            providerID: 'openai',
            authenticated: true,
            maskedCredential: 'sk-t...cret',
        });
        expect(afterSave).toEqual([saved]);
        expect(JSON.stringify(afterSave)).not.toContain('sk-test-secret');
    });

    it('parses explicit failed and approval-blocked desktop command receipt states', () => {
        // Given
        const failedReceipt = {
            sessionId: 'session_failed',
            status: 'failed',
            eventsWritten: 1,
        };
        const blockedReceipt = {
            sessionId: 'session_blocked',
            status: 'blocked_on_approval',
            eventsWritten: 2,
        };
        const unknownReceipt = {
            sessionId: 'session_unknown',
            status: 'unknown_state',
            eventsWritten: 0,
        };

        // When
        const failed = DesktopCommandReceiptSchema.parse(failedReceipt);
        const blocked = DesktopCommandReceiptSchema.parse(blockedReceipt);

        // Then
        expect(failed.status).toBe('failed');
        expect(blocked.status).toBe('blocked_on_approval');
        expect(DesktopCommandReceiptSchema.safeParse(unknownReceipt).success).toBe(false);
    });

    it('redacts credential families from desktop display text', () => {
        // Given
        const secrets = desktopSecretFixtures();

        // When
        const redacted = redactDisplayText(desktopSecretPayload(secrets));

        // Then
        expect(redacted).toContain('[REDACTED_CREDENTIAL]');
        for (const secret of secrets) {
            expect(redacted).not.toContain(secret);
        }
    });
});

function desktopSecretFixtures(): readonly string[] {
    return [
        ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJkZXNrdG9wIjoibWlzc2lvbi1jb250cm9sIn0', 'signaturetest'].join('.'),
        ['ghp', 'testDesktopToken1234567890'].join('_'),
        ['github', 'pat', 'test', 'desktop1234567890'].join('_'),
        ['AKIA', 'TESTDESKTOP12345'].join(''),
        ['Bearer', ['bearer', 'testDesktopToken1234567890'].join('_')].join(' '),
        [
            ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
            'desktop-secret-body',
            ['-----END', 'PRIVATE KEY-----'].join(' '),
        ].join('\n'),
        ['sk', 'proj', 'testDesktopOpenAI1234567890'].join('-'),
        ['sk', 'ant', 'api03', 'testDesktopAnthropic1234567890'].join('-'),
        ['AIza', 'DesktopGoogleToken1234567890'].join(''),
        ['sk', 'or', 'v1', 'testDesktopCompatible1234567890'].join('-'),
    ];
}

function desktopSecretPayload(secrets: readonly string[]): string {
    return secrets.map((secret, index) => `display ${index}: ${secret}`).join('\n');
}
