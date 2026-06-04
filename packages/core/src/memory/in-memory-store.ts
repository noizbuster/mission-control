import type { AbgGraphSnapshot, AgentEvent, AgentSession, AgentSnapshot } from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline.js';
import { SessionEventLog } from '../session-log.js';
import type { MemoryStore } from './memory-store.js';

export class InMemoryEventStore implements MemoryStore {
    private readonly logs = new Map<string, SessionEventLog>();
    private readonly sessions = new Map<string, AgentSession>();

    async append(event: AgentEvent): Promise<void> {
        if (event.sessionId === undefined) {
            throw new Error('event sessionId is required for memory store append');
        }
        const log = this.getOrCreateLog(event.sessionId);
        log.append(event);
        if (event.type === 'session.started') {
            this.sessions.set(event.sessionId, {
                id: event.sessionId,
                status: 'running',
                startedAt: event.timestamp,
            });
        }
        if (event.type === 'session.stopped') {
            const existing = this.getOrCreateSession(event.sessionId);
            this.sessions.set(event.sessionId, {
                ...existing,
                status: 'stopped',
                stoppedAt: event.timestamp,
            });
        }
    }

    async getEvents(sessionId: string): Promise<readonly AgentEvent[]> {
        return this.getOrCreateLog(sessionId).getEvents();
    }

    async getSnapshot(sessionId: string): Promise<AgentSnapshot> {
        return this.getOrCreateLog(sessionId).getSnapshot(this.getOrCreateSession(sessionId));
    }

    async getGraphSnapshot(sessionId: string, graphId: string): Promise<AbgGraphSnapshot> {
        return this.getOrCreateLog(sessionId).getGraphSnapshot(graphId);
    }

    async getTimeline(sessionId: string): Promise<readonly AbgTimelineEntry[]> {
        return this.getOrCreateLog(sessionId).getTimeline();
    }

    async compact(_sessionId: string): Promise<void> {}

    private getOrCreateLog(sessionId: string): SessionEventLog {
        const existing = this.logs.get(sessionId);
        if (existing !== undefined) {
            return existing;
        }
        const log = new SessionEventLog();
        this.logs.set(sessionId, log);
        return log;
    }

    private getOrCreateSession(sessionId: string): AgentSession {
        const existing = this.sessions.get(sessionId);
        if (existing !== undefined) {
            return existing;
        }
        const session: AgentSession = {
            id: sessionId,
            status: 'running',
            startedAt: new Date(0).toISOString(),
        };
        this.sessions.set(sessionId, session);
        return session;
    }
}
