import { expect, it } from 'vitest';
import { projectJsonlSessionReplayPrefix } from '../session-replay.js';
import { completedChunk, openCoordinatorContext } from './run-coordinator-lifecycle-test-support.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function registerRunCoordinatorEnvelopeTests(): void {
    it('persists durable provider settlements through the coordinator drain', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_provider_settlement');
        const coordinator = context.createCoordinator({
            async *streamTurn(request) {
                yield {
                    kind: 'tool_call_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'tool_call_1',
                        toolName: 'repo.read',
                        argumentsJson: '{}',
                    },
                };
                yield completedChunk(request, 'done');
            },
        });

        // When
        await coordinator.run();
        const events = await context.events();

        // Then
        expect(events.some((event) => event.providerStreamChunk?.kind === 'tool_call_completed')).toBe(true);
        expect(events.some((event) => event.providerStreamChunk?.kind === 'response_completed')).toBe(true);
        await context.store.close();
    });

    it('preserves provider envelope metadata', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_provider_envelope');
        const coordinator = context.createCoordinator({
            async *streamTurn(request) {
                yield completedChunk(request, 'done');
            },
        });
        await coordinator.steer({
            inputId: 'input_envelope',
            messageId: 'message_envelope',
            prompt: 'preserve envelope metadata',
        });

        // When
        await coordinator.wake();
        await context.store.close();
        const contents = await readFile(join(context.dataDir, 'sessions', `${context.sessionId}.jsonl`), 'utf8');
        const replay = projectJsonlSessionReplayPrefix({ sessionId: context.sessionId, contents }).projection;
        const providerEnvelopes = replay.envelopes.filter(
            (envelope) => envelope.event.providerStreamChunk !== undefined,
        );

        // Then
        expect(providerEnvelopes.map((envelope) => envelope.event.providerStreamChunk?.kind)).toEqual([
            'response_started',
            'response_completed',
        ]);
        const correlationId = providerEnvelopes[0]?.correlationId;
        expect(correlationId).toMatch(/^request_/);
        expect(providerEnvelopes[0]?.eventId).toBe(`${correlationId}_provider_event_0`);
        expect(providerEnvelopes[0]?.sequence).toBeGreaterThan(0);
        expect(providerEnvelopes[1]?.correlationId).toBe(correlationId);
        expect(providerEnvelopes[1]?.eventId).toBe(`${correlationId}_provider_event_1`);
    });
}
