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
