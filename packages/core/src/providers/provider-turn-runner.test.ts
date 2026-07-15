// allow: SIZE_OK -- HEAD 446 -> current 472 pure LOC; one provider-turn retry and settlement state-machine regression matrix.
import type { ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import { projectSessionReplay } from '../session-replay.js';
import { createDeterministicProvider } from './deterministic-provider.js';
import { ProviderTurnRunner } from './provider-turn-runner.js';
import { closeProviderChunkIterator } from './provider-turn-timeout.js';
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

    it('accumulates durable envelopes in emission order with monotonic durable sequences', async () => {
        // Given — a turn mixing ephemeral text deltas, durable tool-call completions,
        // and the durable response completion. result.envelopes must hold ONLY the durable
        // envelopes, in the order they were emitted, with sequences monotonic within the
        // durable stream (ephemeral deltas are excluded and do not consume durable sequences).
        const runner = new ProviderTurnRunner({
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'a' },
                { kind: 'tool_call_completed', toolCallId: 'tool_1', toolName: 'repo.read', argumentsJson: '{}' },
                { kind: 'text_delta', delta: 'b' },
                { kind: 'tool_call_completed', toolCallId: 'tool_2', toolName: 'repo.search', argumentsJson: '{}' },
                { kind: 'response_completed', content: 'done' },
            ]),
            now: fixedNow,
            createEventId: (_event, sequence) => `evt_${sequence}`,
        });

        // When
        const result = await runner.runTurn(turnInput('session_durable_order', 'request_durable_order'));

        // Then — output-equivalence lock on durable-only contents, ordering, and sequence assignment.
        expect(result.status).toBe('completed');
        const projected = result.envelopes.map((envelope) => ({
            sequence: envelope.sequence,
            durability: envelope.durability,
            kind: envelope.event.providerStreamChunk?.kind,
        }));
        expect(projected).toEqual([
            { sequence: 0, durability: 'durable', kind: 'response_started' },
            { sequence: 1, durability: 'durable', kind: 'tool_call_completed' },
            { sequence: 2, durability: 'durable', kind: 'tool_call_completed' },
            { sequence: 3, durability: 'durable', kind: 'response_completed' },
        ]);
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
        ).toMatchObject({
            type: 'model.call.failed',
            providerStreamChunk: { kind: 'response_failed', error: { code: 'provider_aborted' } },
        });
        expect(
            projectSessionReplay({ sessionId: overflowStore.sessionId, envelopes: overflow.envelopes }).events.at(-1),
        ).toMatchObject({
            type: 'model.call.failed',
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

    it('surfaces timeout without waiting forever for a non-cooperative iterator close', async () => {
        // Given
        let closeCalls = 0;
        const provider: ProviderAdapter = {
            streamTurn() {
                return {
                    [Symbol.asyncIterator]() {
                        return {
                            next: () => new Promise<IteratorResult<ProviderStreamChunk>>(() => {}),
                            return: () => {
                                closeCalls += 1;
                                return new Promise<IteratorResult<ProviderStreamChunk>>(() => {});
                            },
                        };
                    },
                };
            },
        };
        const runner = new ProviderTurnRunner({ provider, timeoutMs: 10, retryLimit: 0 });

        // When
        const outcome = await Promise.race([
            runner.runTurn(turnInput('session_noncooperative_close', 'request_noncooperative_close')),
            new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
        ]);

        // Then
        expect(outcome).not.toBe('hung');
        if (outcome !== 'hung') {
            expect(outcome).toMatchObject({ status: 'failed', error: { code: 'provider_timeout' } });
        }
        expect(closeCalls).toBe(1);
    });

    it('absorbs synchronous iterator close failures', async () => {
        const iterator: AsyncIterator<ProviderStreamChunk> = {
            next: () => new Promise<IteratorResult<ProviderStreamChunk>>(() => {}),
            return: () => {
                throw new Error('sync close failure');
            },
        };

        await expect(closeProviderChunkIterator(iterator)).resolves.toBeUndefined();
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

    it('does not record a phantom attempt when aborted during retry backoff', async () => {
        // Given
        const controller = new AbortController();
        const provider = createDeterministicProvider([
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'try again', retryable: true },
                },
            ],
            [{ kind: 'response_completed', content: 'must not run' }],
        ]);
        const runner = new ProviderTurnRunner({ provider, retryLimit: 1, retryBaseDelayMs: 50 });
        setTimeout(() => controller.abort(), 10);

        // When
        const result = await runner.runTurn({
            ...turnInput('session_abort_backoff', 'request_abort_backoff'),
            signal: controller.signal,
        });

        // Then
        expect(result).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'provider_aborted' } });
        expect(provider.attemptCount()).toBe(1);
        expect(result.envelopes.filter((envelope) => envelope.event.type === 'model.call.started')).toHaveLength(1);
    });

    it('retries a thrown transient provider error (fetch/ECONNRESET) and completes on the next attempt', async () => {
        let attempt = 0;
        const provider: ProviderAdapter = {
            streamTurn: (request) => {
                return (async function* stream() {
                    attempt += 1;
                    if (attempt === 1) {
                        throw new Error('fetch failed: ECONNRESET');
                    }
                    yield {
                        kind: 'response_completed',
                        requestId: request.requestId,
                        sequence: 0,
                        message: { messageId: `message_${request.turnId}`, role: 'assistant', content: 'recovered' },
                        finishReason: 'stop',
                    } as ProviderStreamChunk;
                })();
            },
        };
        const runner = new ProviderTurnRunner({ provider, retryLimit: 1 });

        const result = await runner.runTurn(turnInput('session_thrown_retry', 'request_thrown_retry'));

        expect(result.status).toBe('completed');
        expect(result.attempts).toBe(2);
    });

    it('retries a premature stream close (done without response_completed) up to the cap then fails as unknown', async () => {
        const provider: ProviderAdapter = {
            streamTurn: () => (async function* stream() {})(),
        };
        const runner = new ProviderTurnRunner({ provider, retryLimit: 1 });

        const result = await runner.runTurn(turnInput('session_premature_close', 'request_premature'));

        expect(result.status).toBe('failed');
        expect(result.attempts).toBe(2);
        if (result.status === 'failed') {
            expect(result.error.code).toBe('unknown');
        }
    });

    it('applies exponential backoff starting with the first retry', async () => {
        const provider = createDeterministicProvider([
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [{ kind: 'response_completed', content: 'recovered' }],
        ]);
        const runner = new ProviderTurnRunner({
            provider,
            retryLimit: 5,
            retryBaseDelayMs: 50,
            maxRetryDelayMs: 200,
        });

        const start = Date.now();
        const result = await runner.runTurn(turnInput('session_backoff', 'request_backoff'));
        const elapsed = Date.now() - start;

        expect(result).toMatchObject({ status: 'completed', attempts: 4 });
        expect(provider.attemptCount()).toBe(4);
        expect(elapsed).toBeGreaterThanOrEqual(340);
    });

    it('caps retry delay at maxRetryDelayMs', async () => {
        const provider = createDeterministicProvider([
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [{ kind: 'response_completed', content: 'recovered' }],
        ]);
        const runner = new ProviderTurnRunner({
            provider,
            retryLimit: 5,
            retryBaseDelayMs: 100,
            maxRetryDelayMs: 150,
        });

        const start = Date.now();
        const result = await runner.runTurn(turnInput('session_backoff_cap', 'request_backoff_cap'));
        const elapsed = Date.now() - start;

        expect(result).toMatchObject({ status: 'completed', attempts: 5 });
        expect(elapsed).toBeGreaterThanOrEqual(540);
    });

    it('fails with a credential-free error before stream state reads a hostile chunk accessor', async () => {
        const credential = ['runner', 'hostile', 'credential'].join('_');
        const chunk = {
            kind: 'text_delta',
            requestId: 'request_hostile_completed',
            sequence: 1,
            delta: '',
        } satisfies ProviderStreamChunk;
        Object.defineProperty(chunk, 'delta', {
            enumerable: true,
            get: () => {
                throw new Error(`getter exposed ${credential}`);
            },
        });
        const provider: ProviderAdapter = {
            streamTurn: async function* () {
                yield chunk;
            },
        };
        const runner = new ProviderTurnRunner({ provider, retryLimit: 0 });
        const result = await runner.runTurn(turnInput('session_hostile_completed', 'request_hostile_completed'));

        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error('Expected a failed provider turn');
        expect(result.error).toMatchObject({ message: 'Provider stream chunk could not be redacted' });
        expect(JSON.stringify(result)).not.toContain(credential);
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
