import type { ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import { projectSessionReplay } from '../session-replay.js';
import { createDeterministicProvider } from './deterministic-provider.js';
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

describe('ProviderTurnRunner', () => {
    it('streams deltas ephemerally and stores only durable final assistant history', async () => {
        // Given
        const { store, dataDir, sessionId } = await openStore('session_provider_stream');
        const liveKinds: string[] = [];
        const runner = new ProviderTurnRunner({
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'hel' },
                { kind: 'text_delta', delta: 'lo' },
                { kind: 'response_completed', content: 'hello' },
            ]),
            now: fixedNow,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        // When
        const result = await runner.runTurn({
            sessionId,
            turnId: 'turn_hello',
            requestId: 'request_hello',
            providerID: 'local',
            modelID: 'deterministic',
            messages: [{ role: 'user', content: 'say hello' }],
            startSequence: 0,
            writeEnvelope: (envelope) => store.appendEnvelope(envelope),
            onEnvelope: (envelope) => {
                liveKinds.push(envelope.event.providerStreamChunk?.kind ?? envelope.event.type);
            },
        });
        await store.close();
        const jsonl = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
        const replay = projectSessionReplay({ sessionId, envelopes: result.envelopes });

        // Then
        expect(result.status).toBe('completed');
        expect(liveKinds).toEqual(['response_started', 'text_delta', 'text_delta', 'response_completed']);
        expect(jsonl).not.toContain('"kind":"text_delta"');
        expect(jsonl).not.toContain('"delta":"hel"');
        expect(jsonl).not.toContain('"delta":"lo"');
        expect(jsonl).toContain('hello');
        expect(replay.snapshot.lastMessage).toBe('hello');
    });

    it('stops scripted tool calls at the provider turn loop limit', async () => {
        // Given
        const { store, sessionId } = await openStore('session_provider_loop_limit');
        const runner = new ProviderTurnRunner({
            provider: createDeterministicProvider([
                { kind: 'tool_call_completed', toolCallId: 'tool_1', toolName: 'repo.read', argumentsJson: '{}' },
                { kind: 'tool_call_completed', toolCallId: 'tool_2', toolName: 'repo.search', argumentsJson: '{}' },
            ]),
            now: fixedNow,
            createEventId: (_event, sequence) => `event_${sequence}`,
            toolCallLoopLimit: 1,
        });

        // When
        const result = await runner.runTurn({
            sessionId,
            turnId: 'turn_loop_limit',
            requestId: 'request_loop_limit',
            providerID: 'local',
            modelID: 'deterministic',
            messages: [{ role: 'user', content: 'call tools' }],
            startSequence: 0,
            writeEnvelope: (envelope) => store.appendEnvelope(envelope),
        });
        await store.close();

        // Then
        expect(result).toMatchObject({
            status: 'failed',
            error: {
                code: 'tool_failed',
                retryable: false,
            },
        });
        expect(result.envelopes.at(-1)?.event.providerStreamChunk).toMatchObject({
            kind: 'response_failed',
            error: {
                code: 'tool_failed',
            },
        });
    });

    it('emits typed abort and context overflow failures as replayable durable events', async () => {
        // Given
        const abortController = new AbortController();
        abortController.abort();
        const abortStore = await openStore('session_provider_abort');
        const overflowStore = await openStore('session_provider_context_overflow');
        const abortRunner = new ProviderTurnRunner({
            provider: createDeterministicProvider([{ kind: 'response_completed', content: 'too late' }]),
            now: fixedNow,
            createEventId: (_event, sequence) => `abort_event_${sequence}`,
        });
        const overflowRunner = new ProviderTurnRunner({
            provider: createDeterministicProvider([
                {
                    kind: 'response_failed',
                    error: {
                        code: 'provider_context_overflow',
                        message: 'context window exceeded',
                        retryable: false,
                    },
                },
            ]),
            now: fixedNow,
            createEventId: (_event, sequence) => `overflow_event_${sequence}`,
        });

        // When
        const aborted = await abortRunner.runTurn({
            ...turnInput(abortStore.sessionId, 'request_abort'),
            signal: abortController.signal,
            writeEnvelope: (envelope) => abortStore.store.appendEnvelope(envelope),
        });
        const overflow = await overflowRunner.runTurn({
            ...turnInput(overflowStore.sessionId, 'request_overflow'),
            writeEnvelope: (envelope) => overflowStore.store.appendEnvelope(envelope),
        });
        await abortStore.store.close();
        await overflowStore.store.close();

        // Then
        expect(aborted).toMatchObject({ status: 'failed', error: { code: 'provider_aborted' } });
        expect(overflow).toMatchObject({ status: 'failed', error: { code: 'provider_context_overflow' } });
        expect(
            projectSessionReplay({ sessionId: abortStore.sessionId, envelopes: aborted.envelopes }).events.at(-1),
        ).toMatchObject({ providerStreamChunk: { kind: 'response_failed', error: { code: 'provider_aborted' } } });
        expect(
            projectSessionReplay({ sessionId: overflowStore.sessionId, envelopes: overflow.envelopes }).events.at(-1),
        ).toMatchObject({
            providerStreamChunk: { kind: 'response_failed', error: { code: 'provider_context_overflow' } },
        });
    });

    it('emits typed timeout failures when the provider stream does not produce a chunk in time', async () => {
        // Given
        const { store, sessionId } = await openStore('session_provider_timeout');
        const runner = new ProviderTurnRunner({
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 20 },
                { kind: 'response_completed', content: 'late' },
            ]),
            now: fixedNow,
            createEventId: (_event, sequence) => `event_${sequence}`,
            timeoutMs: 1,
            retryLimit: 0,
        });

        // When
        const result = await runner.runTurn({
            ...turnInput(sessionId, 'request_timeout'),
            writeEnvelope: (envelope) => store.appendEnvelope(envelope),
        });
        await store.close();

        // Then
        expect(result).toMatchObject({
            status: 'failed',
            error: {
                code: 'provider_timeout',
                retryable: true,
            },
        });
    });

    it('cancels and closes the provider iterator when a turn times out', async () => {
        // Given
        let returnCalled = false;
        let observedSignal: AbortSignal | undefined;
        const provider: ProviderAdapter = {
            streamTurn(_request, context) {
                const iterator: AsyncIterator<ProviderStreamChunk> = {
                    next() {
                        observedSignal = context.signal;
                        return new Promise<IteratorResult<ProviderStreamChunk>>(() => {});
                    },
                    return() {
                        returnCalled = true;
                        return Promise.resolve({ done: true, value: undefined });
                    },
                };
                return {
                    [Symbol.asyncIterator]() {
                        return iterator;
                    },
                };
            },
        };
        const runner = new ProviderTurnRunner({
            provider,
            timeoutMs: 1,
            retryLimit: 0,
        });

        // When
        const result = await runner.runTurn(turnInput('session_provider_timeout_cancel', 'request_timeout_cancel'));

        // Then
        expect(result).toMatchObject({ status: 'failed', error: { code: 'provider_timeout' } });
        expect(returnCalled).toBe(true);
        expect(observedSignal?.aborted).toBe(true);
    });

    it('retries retryable provider failures only up to the configured cap', async () => {
        // Given
        const { store, sessionId } = await openStore('session_provider_retry');
        const provider = createDeterministicProvider([
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'try again', retryable: true },
                },
            ],
            [{ kind: 'response_completed', content: 'recovered' }],
        ]);
        const runner = new ProviderTurnRunner({
            provider,
            now: fixedNow,
            createEventId: (_event, sequence) => `event_${sequence}`,
            retryLimit: 1,
        });

        // When
        const result = await runner.runTurn({
            ...turnInput(sessionId, 'request_retry'),
            writeEnvelope: (envelope) => store.appendEnvelope(envelope),
        });
        await store.close();

        // Then
        expect(result).toMatchObject({ status: 'completed', attempts: 2 });
        expect(result.envelopes.at(-1)?.event.message).toBe('recovered');
        expect(provider.attemptCount()).toBe(2);
    });
});

async function openStore(sessionId: string): Promise<{
    readonly dataDir: string;
    readonly sessionId: string;
    readonly store: JsonlSessionEventStore;
}> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-provider-turn-'));
    tempDirs.push(dataDir);
    return {
        dataDir,
        sessionId,
        store: await JsonlSessionEventStore.open({ sessionId, dataDir }),
    };
}

function turnInput(sessionId: string, requestId: string) {
    return {
        sessionId,
        turnId: `turn_${requestId}`,
        requestId,
        providerID: 'local',
        modelID: 'deterministic',
        messages: [{ role: 'user' as const, content: 'run provider' }],
        startSequence: 0,
    };
}

function fixedNow(): string {
    return '2026-06-08T10:00:00.000Z';
}
