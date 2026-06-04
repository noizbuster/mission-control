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

    it('returns ABG timeline for a session', async () => {
        const store = new InMemoryEventStore();

        await store.append({
            type: 'graph.started',
            timestamp: '2026-06-03T10:00:00.000Z',
            sessionId: 'session_abg',
            abg: {
                graphId: 'graph_memory',
            },
        });
        await store.append({
            type: 'node.completed',
            timestamp: '2026-06-03T10:00:01.000Z',
            sessionId: 'session_abg',
            message: 'node completed: llm',
            abg: {
                graphId: 'graph_memory',
                nodeId: 'llm',
                signalType: 'success',
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                },
            },
        });

        expect(await store.getTimeline('session_abg')).toMatchObject([
            {
                type: 'graph.started',
                graphId: 'graph_memory',
            },
            {
                type: 'node.completed',
                graphId: 'graph_memory',
                nodeId: 'llm',
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                },
            },
        ]);
        expect(await store.getGraphSnapshot('session_abg', 'graph_memory')).toMatchObject({
            graphId: 'graph_memory',
            nodes: [
                {
                    nodeId: 'llm',
                    status: 'succeeded',
                },
            ],
        });
    });

    it('returns empty ABG timeline for an unknown session', async () => {
        const store = new InMemoryEventStore();

        await expect(store.getTimeline('missing_session')).resolves.toEqual([]);
    });
});
