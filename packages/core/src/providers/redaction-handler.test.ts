import type { ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import { parseJsonlSessionLog } from '../memory/jsonl-session-records.js';
import { projectSessionReplay } from '../session-replay.js';
import { redactCredentialText } from './credential-resolver.js';
import { ProviderTurnRunner } from './provider-turn-runner.js';
import type { ProviderAdapter } from './provider-turn-types.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('redaction handler', () => {
    it('redacts the default credential family matrix', () => {
        // Given
        const fixtures = credentialFixtures();

        // When
        const redacted = redactCredentialText(matrixPayload(fixtures), knownSecrets(fixtures));

        // Then
        expect(redacted).toContain('[REDACTED_CREDENTIAL]');
        for (const fixture of fixtures) {
            expect(redacted).not.toContain(fixture.secret);
        }
    });

    it('redacts provider failure events before JSONL replay', async () => {
        // Given
        const fixtures = defaultDetectableCredentialFixtures();
        const dataDir = await createTempDataDir();
        const sessionId = 'session_redaction_matrix';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            now: () => '2026-06-12T00:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const runner = new ProviderTurnRunner({
            provider: throwingProvider(matrixPayload(fixtures)),
            now: () => '2026-06-12T00:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
            retryLimit: 0,
        });

        try {
            // When
            const result = await runner.runTurn({
                sessionId,
                turnId: 'turn_redaction_matrix',
                requestId: 'request_redaction_matrix',
                providerID: 'local',
                modelID: 'deterministic',
                messages: [{ role: 'user', content: 'redact provider failure matrix' }],
                startSequence: 0,
                writeEnvelope: (envelope) => store.appendEnvelope(envelope),
            });
            await store.close();
            const jsonl = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
            const parsed = parseJsonlSessionLog({ sessionId, contents: jsonl, filePath: `${sessionId}.jsonl` });
            const replay = projectSessionReplay({ sessionId, envelopes: parsed.envelopes });

            // Then
            expect(result.status).toBe('failed');
            for (const fixture of fixtures) {
                expect(JSON.stringify(result)).not.toContain(fixture.secret);
                expect(jsonl).not.toContain(fixture.secret);
                expect(JSON.stringify(replay)).not.toContain(fixture.secret);
            }
        } finally {
            await store.close();
        }
    });
});

type CredentialFixture = {
    readonly name: string;
    readonly secret: string;
    readonly knownSecret?: boolean;
    readonly render?: (secret: string) => string;
};

function credentialFixtures(): readonly CredentialFixture[] {
    return [
        {
            name: 'jwt',
            secret: [
                'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
                'eyJzdWIiOiJtaXNzaW9uLWNvbnRyb2wifQ',
                'signaturetest',
            ].join('.'),
        },
        { name: 'github classic', secret: ['ghp', 'testClassicToken1234567890'].join('_') },
        { name: 'github fine grained', secret: ['github', 'pat', 'test', 'finegrained1234567890'].join('_') },
        { name: 'aws access key', secret: ['AKIA', 'TESTCREDENTIAL12'].join('') },
        {
            name: 'bearer token',
            secret: ['bearer', 'testOpaqueToken1234567890'].join('_'),
            render: (secret) => `Authorization: Bearer ${secret}`,
        },
        {
            name: 'pem block',
            secret: [
                ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
                'abc123',
                ['-----END', 'PRIVATE KEY-----'].join(' '),
            ].join('\n'),
        },
        { name: 'openai', secret: ['sk', 'proj', 'testOpenAI1234567890'].join('-') },
        { name: 'anthropic', secret: ['sk', 'ant', 'api03', 'testAnthropic1234567890'].join('-') },
        { name: 'google', secret: ['AIza', 'SyDTestGoogleToken1234567890'].join('') },
        { name: 'compatible', secret: ['sk', 'or', 'v1', 'testCompatible1234567890'].join('-') },
        {
            name: 'known multiline',
            secret: ['multi_line_secret', 'second_line_secret'].join('\n'),
            knownSecret: true,
        },
    ];
}

function matrixPayload(fixtures: readonly CredentialFixture[]): string {
    return fixtures
        .map((fixture) => `${fixture.name}: ${fixture.render?.(fixture.secret) ?? fixture.secret}`)
        .join('\n');
}

function knownSecrets(fixtures: readonly CredentialFixture[]): readonly string[] {
    return fixtures.filter((fixture) => fixture.knownSecret === true).map((fixture) => fixture.secret);
}

function defaultDetectableCredentialFixtures(): readonly CredentialFixture[] {
    return credentialFixtures().filter((fixture) => fixture.knownSecret !== true);
}

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-redaction-handler-'));
    tempDirs.push(dataDir);
    return dataDir;
}

function throwingProvider(message: string): ProviderAdapter {
    return {
        streamTurn() {
            return rejectingProviderStream(message);
        },
    };
}

function rejectingProviderStream(message: string): AsyncIterable<ProviderStreamChunk> {
    return {
        [Symbol.asyncIterator]() {
            return {
                next(): Promise<IteratorResult<ProviderStreamChunk>> {
                    return Promise.reject(new Error(message));
                },
            };
        },
    };
}
