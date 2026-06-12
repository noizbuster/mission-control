import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import { projectSessionReplay } from '../session-replay.js';
import { createDeterministicProvider } from './deterministic-provider.js';
import { ProviderTurnRunner } from './provider-turn-runner.js';
import type { ProviderAdapter } from './provider-turn-types.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('provider output redaction', () => {
    it('redacts token-like provider text before events JSONL replay and returned messages', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-provider-redaction-'));
        const sessionId = 'session_provider_redaction';
        const secret = ['sk', 'provider_redaction_123'].join('-');
        const store = await JsonlSessionEventStore.open({
            dataDir,
            sessionId,
            now: fixedNow,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const liveMessages: string[] = [];
        const runner = new ProviderTurnRunner({
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: `stream ${secret}` },
                { kind: 'response_completed', content: `final ${secret}` },
            ]),
            now: fixedNow,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When
            const result = await runner.runTurn({
                sessionId,
                turnId: 'turn_redaction',
                requestId: 'request_redaction',
                providerID: 'local',
                modelID: 'deterministic',
                messages: [{ role: 'user', content: 'redact provider output' }],
                startSequence: 0,
                writeEnvelope: (envelope) => store.appendEnvelope(envelope),
                onEnvelope: (envelope) => {
                    liveMessages.push(envelope.event.message ?? '');
                },
            });
            await store.close();
            const jsonl = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
            const replay = projectSessionReplay({ sessionId, envelopes: result.envelopes });

            // Then
            expect(result.status).toBe('completed');
            if (result.status !== 'completed') {
                throw new TypeError('provider redaction turn did not complete');
            }
            expect(result.message.content).toBe('final [REDACTED_CREDENTIAL]');
            expect(liveMessages.join('\n')).not.toContain(secret);
            expect(JSON.stringify(result.envelopes)).not.toContain(secret);
            expect(jsonl).not.toContain(secret);
            expect(replay.snapshot.lastMessage).toBe('final [REDACTED_CREDENTIAL]');
        } finally {
            await store.close();
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('redacts token-like provider failures before returning failed results', async () => {
        // Given
        const sessionId = 'session_provider_failure_redaction';
        const secret = ['sk', 'provider_failure_123'].join('-');
        const runner = new ProviderTurnRunner({
            provider: throwingProvider(`provider exploded ${secret}`),
            now: fixedNow,
            createEventId: (_event, sequence) => `event_${sequence}`,
            retryLimit: 0,
        });

        // When
        const result = await runner.runTurn({
            sessionId,
            turnId: 'turn_failure_redaction',
            requestId: 'request_failure_redaction',
            providerID: 'local',
            modelID: 'deterministic',
            messages: [{ role: 'user', content: 'redact provider failure' }],
            startSequence: 0,
        });

        // Then
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') {
            throw new TypeError('provider redaction turn did not fail');
        }
        expect(result.error.message).toBe('provider exploded [REDACTED_CREDENTIAL]');
        expect(result.error.redactions).toEqual([
            {
                classification: 'credential',
                reason: 'token-like provider credential redacted',
                replacement: '[REDACTED_CREDENTIAL]',
            },
        ]);
        expect(JSON.stringify(result)).not.toContain(secret);
    });
});

function fixedNow(): string {
    return '2026-06-09T00:00:00.000Z';
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
