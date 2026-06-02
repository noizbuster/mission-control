import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from './in-memory-store.js';

describe('InMemoryEventStore', () => {
    it('appends events and derives snapshot', async () => {
        const store = new InMemoryEventStore();

        await store.append({
            type: 'session.started',
            timestamp: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_test',
            nativeSidecarStatus: 'mock',
        });
        await store.append({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:01.000Z',
            sessionId: 'session_test',
            taskId: 'task_1',
            message: 'done',
            nativeSidecarStatus: 'mock',
        });

        expect(await store.getEvents('session_test')).toHaveLength(2);
        await expect(store.getSnapshot('session_test')).resolves.toMatchObject({
            sessionId: 'session_test',
            completedTaskCount: 1,
            lastMessage: 'done',
        });
    });
});
