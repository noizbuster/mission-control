import type { AgentSession } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { SessionEventLog } from './session-log.js';

describe('SessionEventLog', () => {
    it('keeps events append-only and derives snapshots from the log', () => {
        const session: AgentSession = {
            id: 'session_test',
            status: 'stopped',
            startedAt: '2026-06-02T10:00:00.000Z',
        };
        const log = new SessionEventLog();

        log.append({
            type: 'session.started',
            timestamp: session.startedAt,
            sessionId: session.id,
            nativeSidecarStatus: 'mock',
        });
        log.append({
            type: 'task.started',
            timestamp: '2026-06-02T10:00:01.000Z',
            sessionId: session.id,
            taskId: 'task_1',
            nativeSidecarStatus: 'mock',
        });
        log.append({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:02.000Z',
            sessionId: session.id,
            taskId: 'task_1',
            message: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
        });
        log.append({
            type: 'session.stopped',
            timestamp: '2026-06-02T10:00:03.000Z',
            sessionId: session.id,
            nativeSidecarStatus: 'mock',
        });

        const externalEvents = log.getEvents();
        externalEvents.pop();

        expect(log.getEvents()).toHaveLength(4);
        expect(log.getSnapshot(session)).toMatchObject({
            sessionId: session.id,
            status: 'stopped',
            startedAt: session.startedAt,
            stoppedAt: '2026-06-02T10:00:03.000Z',
            runningTaskCount: 0,
            completedTaskCount: 1,
            failedTaskCount: 0,
            lastMessage: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
        });
    });
});
