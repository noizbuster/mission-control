import { describe, expect, it } from 'vitest';
import { MockSidecarClient } from './mock-sidecar-client.js';

describe('MockSidecarClient', () => {
    it('mock client returns deterministic demo task output', async () => {
        const client = new MockSidecarClient();

        await client.start();
        const output = await client.runTask({
            id: 'task_1',
            payload: {
                label: 'demo',
            },
        });
        await client.stop();

        expect(output).toEqual({
            id: 'task_1',
            message: 'completed by mock sidecar',
        });
    });
});
