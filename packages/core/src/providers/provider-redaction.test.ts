import { describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import { projectSessionReplay } from '../session-replay.js';
import { createDeterministicProvider } from './deterministic-provider.js';
import { ProviderTurnRunner } from './provider-turn-runner.js';
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
});

function fixedNow(): string {
    return '2026-06-09T00:00:00.000Z';
}
