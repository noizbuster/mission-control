import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('Desktop event log fields', () => {
    it('renders structured event type timestamp message task id and sidecar status fields', () => {
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_test"
                initialEvents={[
                    {
                        type: 'task.completed',
                        timestamp: '2026-06-02T10:00:00.000Z',
                        sessionId: 'session_test',
                        taskId: 'task_1',
                        message: 'completed by mock sidecar',
                        nativeSidecarStatus: 'mock',
                    },
                ]}
            />,
        );

        expect(html).toContain('event type');
        expect(html).toContain('timestamp');
        expect(html).toContain('message');
        expect(html).toContain('task id');
        expect(html).toContain('sidecar');
        expect(html).toContain('data-testid="event-row-task_1"');
    });

    it('renders provider and model fields in the event log', () => {
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_test"
                initialEvents={[
                    {
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
                    },
                ]}
            />,
        );

        expect(html).toContain('model');
        expect(html).toContain('local/local-echo');
    });

    it('renders graph metadata in the event log', () => {
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_test"
                initialEvents={[
                    {
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
                    },
                ]}
            />,
        );

        expect(html).toContain('graph');
        expect(html).toContain('node');
        expect(html).toContain('signal');
        expect(html).toContain('research-answer');
        expect(html).toContain('answer');
        expect(html).toContain('success');
        expect(html).toContain('local/local-echo/default');
    });
});
