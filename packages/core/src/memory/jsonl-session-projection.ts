import type { AgentEvent, AgentSession } from '@mission-control/protocol';

export function deriveSession(sessionId: string, events: readonly AgentEvent[]): AgentSession {
    let session = defaultSession(sessionId);
    for (const event of events) {
        if (event.type === 'session.started') {
            session = {
                id: sessionId,
                status: 'running',
                startedAt: event.timestamp,
            };
        }
        if (event.type === 'session.stopped') {
            session = {
                ...session,
                status: 'stopped',
                stoppedAt: event.timestamp,
            };
        }
        if (event.type === 'run.started' || event.type === 'task.started') {
            session = {
                id: session.id,
                status: 'running',
                startedAt: session.startedAt,
            };
        }
        if (
            event.type === 'run.completed' ||
            event.type === 'run.failed' ||
            event.type === 'run.interrupted' ||
            event.type === 'run.idle' ||
            event.type === 'task.completed' ||
            event.type === 'task.failed'
        ) {
            session = {
                id: session.id,
                status: 'idle',
                startedAt: session.startedAt,
            };
        }
    }
    return session;
}

export function defaultSession(sessionId: string): AgentSession {
    return {
        id: sessionId,
        status: 'running',
        startedAt: new Date(0).toISOString(),
    };
}
