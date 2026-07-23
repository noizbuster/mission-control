import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createObservabilityRedactor } from '../providers/observability-redactor';
import { REDACTED_CREDENTIAL } from '../providers/redaction-handler';
import { createAbgEmitSignal } from './abg-emit';
import { CANONICAL_FAILURE_CODES } from './failure-taxonomy';
import { isEphemeralStreamingAbgSignal, projectAbgSignalToEvent } from './signals';

const NOW = '2026-06-16T00:00:00.000Z';

function emitSignal(eventType: string, payload?: unknown): AbgSignal {
    return createAbgEmitSignal({
        graphId: 'graph_test',
        nodeId: 'llm_actor',
        source: 'llm-actor',
        eventType,
        timestamp: NOW,
        ...(payload !== undefined ? { payload } : {}),
    });
}

describe('projectAbgSignalToEvent — emit payload preservation', () => {
    it('persists the structured type + payload for a boundary emit (llm.turn.completed)', () => {
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: emitSignal('llm.turn.completed', { text: 'Done.', usage: { total: 6 } }),
            nodeKind: 'llm',
        });

        expect(event.abg?.emit).toEqual({
            type: 'llm.turn.completed',
            payload: { text: 'Done.', usage: { total: 6 } },
        });
    });

    it('persists the type + payload for the other coding-step boundary emits', () => {
        const cases = [
            ['llm.tool_call.proposed', { toolCallId: 'call_1', toolName: 'file.patch', input: {} }],
            ['tool.started', { toolCallId: 'call_1', toolName: 'file.patch' }],
            ['tool.completed', { toolCallId: 'call_1', toolName: 'file.patch' }],
            ['tool.failed', { toolCallId: 'call_1', toolName: 'file.patch' }],
            ['llm.error', { error: 'boom' }],
            ['context.packed', { estimatedTokens: 4200, cutPointIndex: 3, summarizedMessageCount: 2 }],
        ] as const;

        for (const [type, payload] of cases) {
            const event = projectAbgSignalToEvent({
                graphId: 'graph_test',
                sessionId: 'session_test',
                timestamp: NOW,
                signal: emitSignal(type, payload),
            });
            expect(event.abg?.emit).toEqual({ type, payload });
        }
    });

    it('persists routing.dead_end payload (nodeId + code + attempt) for durable re-admit observability', () => {
        // Given: progress-contract re-admit emit shape
        const payload = {
            nodeId: 'assess-ambiguity',
            code: CANONICAL_FAILURE_CODES.ROUTING_DEAD_END,
            attempt: 2,
        };

        // When
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: emitSignal('routing.dead_end', payload),
            nodeKind: 'action',
            attempt: 2,
            maxAttempts: 3,
        });

        // Then: allowlisted boundary emit keeps structured payload on durable ledger
        expect(event.durability).toBe('durable');
        expect(event.abg?.nodeId).toBe('llm_actor');
        expect(event.abg?.emit).toEqual({ type: 'routing.dead_end', payload });
        expect(event.message).toBe('node emitted event: routing.dead_end');
    });

    it('redacts credentials from routing.dead_end emit payloads and messages', () => {
        // Given: secret-bearing payload (must never land in durable events)
        const secret = ['sk', 'live', 'deadendsecret123'].join('-');
        const redactor = createObservabilityRedactor({ secrets: [secret] });

        // When
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: emitSignal('routing.dead_end', {
                nodeId: 'gate',
                code: CANONICAL_FAILURE_CODES.ROUTING_DEAD_END,
                attempt: 1,
                note: `retry after ${secret}`,
            }),
            observabilityRedactor: redactor,
        });
        const observable = JSON.stringify(event);

        // Then
        expect(event.abg?.emit?.type).toBe('routing.dead_end');
        expect(observable).not.toContain(secret);
        expect(observable).toContain(REDACTED_CREDENTIAL);
    });

    it('marks high-frequency streaming emits as ephemeral (not durable ledger rows)', () => {
        // Given: per-token streaming emit
        const textDelta = emitSignal('llm.text.delta', { delta: 'tok' });
        const reasoningDelta = emitSignal('llm.reasoning.delta', { delta: 'think' });
        const boundary = emitSignal('llm.turn.completed', { text: 'Done.' });

        // When / Then: streaming is ephemeral; boundary is not
        expect(isEphemeralStreamingAbgSignal(textDelta)).toBe(true);
        expect(isEphemeralStreamingAbgSignal(reasoningDelta)).toBe(true);
        expect(isEphemeralStreamingAbgSignal(boundary)).toBe(false);

        // Projection still omits structured payload if ever projected
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: textDelta,
        });
        expect(event.abg?.emit).toBeUndefined();
    });

    it('carries no emit metadata for non-emit signals', () => {
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: { type: 'started', graphId: 'graph_test', nodeId: 'llm_actor' },
        });

        expect(event.abg?.emit).toBeUndefined();
        expect(event.abg?.signalType).toBe('started');
    });
});

describe('projectAbgSignalToEvent — structured admission failure durability', () => {
    it('persists invalid_structured_output code on abg.error with nodeId (no free-form emit invent)', () => {
        // Given: llm-actor fail-closed admission failure signal
        const signal: AbgSignal = {
            type: 'failure',
            graphId: 'graph_test',
            nodeId: 'assess-ambiguity',
            error: {
                code: CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT,
                message: 'invalid structured output for outputKey ambiguity.classification: not in enum',
            },
        };

        // When
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal,
            nodeKind: 'llm',
            attempt: 1,
            maxAttempts: 3,
        });

        // Then: durable node.failed carries nodeId + canonical code
        expect(event.type).toBe('node.failed');
        expect(event.durability).toBe('durable');
        expect(event.abg?.nodeId).toBe('assess-ambiguity');
        expect(event.abg?.error).toEqual({
            code: CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT,
            message: 'invalid structured output for outputKey ambiguity.classification: not in enum',
        });
        expect(event.abg?.emit).toBeUndefined();
    });

    it('redacts credentials from structured failure error messages', () => {
        // Given
        const secret = ['sk', 'live', 'admissionsecret123'].join('-');
        const redactor = createObservabilityRedactor({ secrets: [secret] });
        const signal: AbgSignal = {
            type: 'failure',
            graphId: 'graph_test',
            nodeId: 'gate',
            error: {
                code: CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT,
                message: `blob contained ${secret}`,
            },
        };

        // When
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal,
            observabilityRedactor: redactor,
        });
        const observable = JSON.stringify(event);

        // Then
        expect(event.abg?.error?.code).toBe(CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT);
        expect(observable).not.toContain(secret);
        expect(observable).toContain(REDACTED_CREDENTIAL);
    });

    it('does not invent abg.error for plain-string failure payloads', () => {
        // Given
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: {
                type: 'failure',
                graphId: 'graph_test',
                nodeId: 'gate',
                error: 'unstructured boom',
            },
        });

        // Then
        expect(event.type).toBe('node.failed');
        expect(event.abg?.error).toBeUndefined();
    });
});
