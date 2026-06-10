import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { DesktopSessionLog, DesktopSessionSummary } from './lib/agent-client.js';

describe('Desktop session timeline fields', () => {
    it('renders structured event type timestamp message task id and sidecar status fields', () => {
        // Given
        const log = sessionLog({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_test',
            taskId: 'task_1',
            message: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
        });

        // When
        const html = renderToStaticMarkup(
            <App initialSessionId="session_test" initialSessionSummaries={[summary()]} initialSessionLog={log} />,
        );

        // Then
        expect(html).toContain('Session timeline');
        expect(html).toContain('task.completed');
        expect(html).toContain('2026-06-02T10:00:00.000Z');
        expect(html).toContain('task_1');
        expect(html).toContain('completed by mock sidecar');
        expect(html).toContain('native sidecar mock');
    });

    it('renders provider and model fields in the session timeline', () => {
        // Given
        const log = sessionLog({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_test',
            taskId: 'task_1',
            message: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });

        // When
        const html = renderToStaticMarkup(
            <App initialSessionId="session_test" initialSessionSummaries={[summary()]} initialSessionLog={log} />,
        );

        // Then
        expect(html).toContain('model');
        expect(html).toContain('local/local-echo');
    });

    it('renders graph metadata in the graph inspector and timeline', () => {
        // Given
        const log = sessionLog({
            type: 'node.completed',
            timestamp: '2026-06-03T10:00:00.000Z',
            sessionId: 'session_test',
            message: 'node completed: answer',
            abg: {
                graphId: 'research-answer',
                nodeId: 'answer',
                signalType: 'success',
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                    variantID: 'default',
                },
            },
        });

        // When
        const html = renderToStaticMarkup(
            <App initialSessionId="session_test" initialSessionSummaries={[summary()]} initialSessionLog={log} />,
        );

        // Then
        expect(html).toContain('graph');
        expect(html).toContain('node');
        expect(html).toContain('signal');
        expect(html).toContain('research-answer');
        expect(html).toContain('answer');
        expect(html).toContain('success');
        expect(html).toContain('local/local-echo/default');
    });
});

type EventInput = DesktopSessionLog['envelopes'][number]['event'];

function sessionLog(event: EventInput): DesktopSessionLog {
    return {
        sessionId: event.sessionId ?? 'session_test',
        state: 'available',
        contents: 'jsonl',
        diagnostics: [],
        envelopes: [
            {
                eventId: 'event_1',
                sequence: 0,
                createdAt: event.timestamp,
                sessionId: event.sessionId ?? 'session_test',
                durability: 'durable',
                event,
            },
        ],
    };
}

function summary(): DesktopSessionSummary {
    return {
        sessionId: 'session_test',
        fileName: 'session_test.jsonl',
        state: 'available',
        eventCount: 1,
        diagnostics: [],
    };
}
