import { describe, expect, it } from 'vitest';
import { createMockDesktopAgentClient } from './agent-client.js';

describe('desktop agent client', () => {
    it('mock desktop client emits demo event log', async () => {
        const client = createMockDesktopAgentClient();
        const session = await client.startDemoSession();
        const events = await client.runDemoTask(session.id);

        expect(session.id).toMatch(/^session_/);
        expect(events.map((event) => event.type)).toEqual([
            'session.started',
            'task.started',
            'task.progress',
            'task.completed',
        ]);
    });
});
