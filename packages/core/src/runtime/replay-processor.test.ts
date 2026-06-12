import { describe, expect, it } from 'vitest';
import { projectSessionReplay } from '../session-replay.js';
import { envelope, providerFailedEvent } from '../session-replay-coding-test-support.js';

describe('runtime replay processor', () => {
    it('projects provider response failure distinctly', () => {
        // Given
        const sessionId = 'session_replay_provider_failure';
        const envelopes = [envelope(providerFailedEvent(sessionId), 0, 'event_provider_failed')];

        // When
        const replay = projectSessionReplay({ sessionId, envelopes });

        // Then
        expect(replay.events[0]?.type).toBe('model.call.failed');
        expect(replay.codingSteps).toEqual([
            {
                kind: 'provider.failure',
                eventId: 'event_provider_failed',
                timestamp: '2026-06-05T10:00:01.000Z',
                providerTurnId: 'task_prompt_1',
                requestId: 'provider_request_task_prompt_1',
                error: {
                    code: 'unknown',
                    message: 'provider exploded',
                    retryable: false,
                },
            },
        ]);
        expect(replay.codingSteps).not.toContainEqual(expect.objectContaining({ kind: 'provider.message' }));
    });
});
