import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('Desktop App', () => {
    it('renders mission-control title, controls, and event log after demo task', () => {
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_test"
                initialEvents={[
                    {
                        type: 'task.completed',
                        timestamp: '2026-06-02T10:00:00.000Z',
                        taskId: 'task_1',
                        message: 'completed by mock sidecar',
                        nativeSidecarStatus: 'mock',
                    },
                ]}
            />,
        );

        expect(html).toContain('mission-control');
        expect(html).toContain('session_test');
        expect(html).toContain('Start demo session');
        expect(html).toContain('Run demo task');
        expect(html).toContain('task.completed');
        expect(html).toContain('completed by mock sidecar');
        expect(html).toContain('mock');
    });
});
