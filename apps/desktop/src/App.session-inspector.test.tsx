import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { DesktopSessionLog } from './lib/agent-client.js';

describe('Desktop read-only session inspector', () => {
    it('renders empty corrupt and missing states without crashing', () => {
        // Given
        const html = renderToStaticMarkup(
            <App
                initialSessionSummaries={[
                    {
                        sessionId: 'empty_session',
                        fileName: 'empty_session.jsonl',
                        state: 'empty',
                        eventCount: 0,
                        diagnostics: [],
                    },
                    {
                        sessionId: 'corrupt_session',
                        fileName: 'corrupt_session.jsonl',
                        state: 'corrupt',
                        eventCount: 1,
                        diagnostics: [{ code: 'corrupt_line', message: 'bad json', lineNumber: 3 }],
                    },
                    {
                        sessionId: 'missing_session',
                        fileName: 'missing_session.jsonl',
                        state: 'missing',
                        eventCount: 0,
                        diagnostics: [],
                    },
                ]}
                initialSessionLog={{
                    sessionId: 'corrupt_session',
                    state: 'corrupt',
                    contents: '',
                    envelopes: [],
                    diagnostics: [{ code: 'corrupt_line', message: 'bad json', lineNumber: 3 }],
                }}
            />,
        );

        // Then
        expect(html).toContain('empty_session');
        expect(html).toContain('corrupt_session');
        expect(html).toContain('missing_session');
        expect(html).toContain('bad json');
        expect(html).toContain('No timeline events');
    });

    it('renders indexed session lock status and update time', () => {
        // Given
        const html = renderToStaticMarkup(
            <App
                initialSessionSummaries={[
                    {
                        sessionId: 'session_stale_lock',
                        fileName: 'session_stale_lock.jsonl',
                        state: 'available',
                        eventCount: 1,
                        diagnostics: [],
                        lockState: 'stale',
                        updatedAt: '2026-06-09T00:10:00.000Z',
                    },
                ]}
                initialSessionLog={{
                    sessionId: 'session_stale_lock',
                    state: 'available',
                    contents: 'jsonl',
                    envelopes: [],
                    diagnostics: [],
                }}
            />,
        );

        // When: the session list is rendered from indexed summary metadata.
        // Then
        expect(html).toContain('data-lock-state="stale"');
        expect(html).toContain('lock stale');
        expect(html).toContain('updated 2026-06-09T00:10:00.000Z');
    });

    it('renders loading and error state surfaces for the operational console', () => {
        // Given
        const html = renderToStaticMarkup(<App />);
        const errorHtml = renderToStaticMarkup(
            <App
                initialSessionSummaries={[
                    {
                        sessionId: 'corrupt_session',
                        fileName: 'corrupt_session.jsonl',
                        state: 'corrupt',
                        eventCount: 0,
                        diagnostics: [{ code: 'corrupt_line', message: 'bad json', lineNumber: 4 }],
                    },
                ]}
                initialSessionLog={{
                    sessionId: 'corrupt_session',
                    state: 'corrupt',
                    contents: '',
                    envelopes: [],
                    diagnostics: [{ code: 'corrupt_line', message: 'bad json', lineNumber: 4 }],
                }}
            />,
        );

        // Then
        expect(html).toContain('data-state="loading"');
        expect(html).toContain('Loading session catalog');
        expect(html).toContain('class="workspace-layout"');
        expect(html).toContain('class="utility-rail"');
        expect(errorHtml).toContain('class="source-status" data-state="error"');
        expect(errorHtml).toContain('corrupt session: 1 diagnostic');
        expect(errorHtml).toContain('data-state="corrupt"');
        expect(errorHtml).toContain('corrupt_line');
        expect(errorHtml).toContain('bad json');
    });

    it('does not project stale log rows when the selected session differs from the loaded log', () => {
        // Given
        const log: DesktopSessionLog = {
            sessionId: 'session_a',
            state: 'available',
            contents: 'jsonl',
            diagnostics: [],
            envelopes: [
                envelope(0, {
                    type: 'task.completed',
                    timestamp: '2026-06-09T00:00:00.000Z',
                    sessionId: 'session_a',
                    message: 'stale session event',
                }),
            ],
        };

        // When
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_b"
                initialSessionSummaries={[
                    {
                        sessionId: 'session_a',
                        fileName: 'session_a.jsonl',
                        state: 'available',
                        eventCount: 1,
                        diagnostics: [],
                    },
                    {
                        sessionId: 'session_b',
                        fileName: 'session_b.jsonl',
                        state: 'empty',
                        eventCount: 0,
                        diagnostics: [],
                    },
                ]}
                initialSessionLog={log}
            />,
        );

        // Then
        expect(html).toContain('session session_b');
        expect(html).toContain('No timeline events');
        expect(html).not.toContain('stale session event');
    });
});

type EventInput = DesktopSessionLog['envelopes'][number]['event'];

function envelope(sequence: number, event: EventInput): DesktopSessionLog['envelopes'][number] {
    return {
        eventId: `event_${sequence}`,
        sequence,
        createdAt: event.timestamp,
        sessionId: 'session_task21',
        durability: 'durable',
        event,
    };
}
