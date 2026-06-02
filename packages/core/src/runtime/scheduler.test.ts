import { describe, expect, it } from 'vitest';
import { MockAgentScheduler } from './scheduler.js';

describe('MockAgentScheduler', () => {
    it('returns TaskHandle and supports cancel placeholder', async () => {
        const scheduler = new MockAgentScheduler();
        const handle = await scheduler.schedule({
            id: 'task_1',
            kind: 'demo',
        });

        expect(handle.status).toBe('running');
        await handle.cancel('test cancel');
        expect(handle.status).toBe('cancelled');
        await expect(scheduler.cancel('task_1')).resolves.toBeUndefined();
    });
});
