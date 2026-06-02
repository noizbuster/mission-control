import type { AgentEvent } from '@mission-control/protocol';
import { useMemo, useState } from 'react';
import { createMockDesktopAgentClient } from './lib/agent-client.js';

export type AppProps = {
    readonly initialSessionId?: string;
    readonly initialEvents?: readonly AgentEvent[];
};

export function App({ initialSessionId, initialEvents = [] }: AppProps): React.JSX.Element {
    const client = useMemo(() => createMockDesktopAgentClient(), []);
    const [sessionId, setSessionId] = useState<string>(initialSessionId ?? 'not started');
    const [events, setEvents] = useState<readonly AgentEvent[]>(initialEvents);
    const nativeStatus = events.at(-1)?.nativeSidecarStatus ?? 'mock';

    async function startDemoSession(): Promise<void> {
        const session = await client.startDemoSession();
        setSessionId(session.id);
        setEvents([
            {
                type: 'session.started',
                timestamp: session.startedAt,
                sessionId: session.id,
                message: 'desktop demo session started',
                nativeSidecarStatus: 'mock',
            },
        ]);
    }

    async function runDemoTask(): Promise<void> {
        const activeSessionId = sessionId === 'not started' ? (await client.startDemoSession()).id : sessionId;
        setSessionId(activeSessionId);
        setEvents(await client.runDemoTask(activeSessionId));
    }

    return (
        <main className="shell">
            <header className="topbar">
                <div>
                    <h1>mission-control</h1>
                    <p className="session">session {sessionId}</p>
                </div>
                <div className="status" data-testid="native-status">
                    native sidecar {nativeStatus}
                </div>
            </header>

            <section className="controls" aria-label="demo controls">
                <button type="button" onClick={startDemoSession}>
                    Start demo session
                </button>
                <button type="button" onClick={runDemoTask}>
                    Run demo task
                </button>
            </section>

            <section className="event-log" aria-label="event log">
                <div className="event-log-header">
                    <span>event type</span>
                    <span>timestamp</span>
                    <span>message</span>
                    <span>task id</span>
                    <span>sidecar</span>
                </div>
                {events.map((event) => (
                    <div
                        className="event-row"
                        data-testid={`event-row-${event.taskId ?? event.type}`}
                        key={`${event.type}-${event.timestamp}-${event.taskId ?? 'session'}`}
                    >
                        <span>{event.type}</span>
                        <time dateTime={event.timestamp}>{event.timestamp}</time>
                        <span>{event.message ?? ''}</span>
                        <span>{event.taskId ?? ''}</span>
                        <span>{event.nativeSidecarStatus ?? 'mock'}</span>
                    </div>
                ))}
            </section>
        </main>
    );
}
