import type { SessionInspectorProjection } from './lib/session-inspector.js';

type PanelProps = {
    readonly projection: SessionInspectorProjection;
    readonly selectedSessionId: string;
    readonly onSelectSession: (sessionId: string) => void;
    readonly onDecideApproval: (approvalId: string, state: 'approved' | 'denied') => void;
};

export function SessionListPanel({
    projection,
    selectedSessionId,
    onSelectSession,
}: Pick<PanelProps, 'projection' | 'selectedSessionId' | 'onSelectSession'>): React.JSX.Element {
    return (
        <aside className="session-list" aria-label="sessions">
            <h2>Sessions</h2>
            {projection.sessions.length === 0 ? <p className="empty-state">No session logs</p> : null}
            {projection.sessions.map((session) => (
                <button
                    className="session-item"
                    data-lock-state={session.lockState ?? 'none'}
                    data-selected={session.sessionId === selectedSessionId}
                    data-state={session.state}
                    key={session.sessionId}
                    type="button"
                    onClick={() => onSelectSession(session.sessionId)}
                >
                    <span className="session-item-title">{session.sessionId}</span>
                    <span>{session.eventCount} events</span>
                    <span>lock {session.lockState ?? 'none'}</span>
                    {session.workspaceTrust !== undefined ? <span>trust {session.workspaceTrust}</span> : null}
                    {session.pendingApprovalCount !== undefined ? (
                        <span>pending {session.pendingApprovalCount}</span>
                    ) : null}
                    {session.blockedRunCount !== undefined ? <span>blocked {session.blockedRunCount}</span> : null}
                    {session.updatedAt !== undefined ? <span>updated {session.updatedAt}</span> : null}
                </button>
            ))}
            <h2>Branch navigator</h2>
            {projection.branches.length === 0 ? <p className="empty-state">No branches</p> : null}
            {projection.branches.map((branch) => (
                <div className="compact-row" key={branch.key}>
                    <strong>{branch.delivery}</strong>
                    <span>{branch.messageId}</span>
                    <span>{branch.parentMessageId}</span>
                    <span>{branch.message}</span>
                </div>
            ))}
        </aside>
    );
}

export function TimelinePanelSection({ projection }: Pick<PanelProps, 'projection'>): React.JSX.Element {
    return (
        <section className="timeline-panel" aria-label="session timeline">
            <h2>Session timeline</h2>
            {projection.timeline.length === 0 ? <p className="empty-state">No timeline events</p> : null}
            {projection.timeline.length > 0 ? (
                <div className="timeline-row timeline-header">
                    <span>event</span>
                    <span>timestamp</span>
                    <span>task / graph</span>
                    <span>node / signal</span>
                    <span>model / message</span>
                </div>
            ) : null}
            {projection.timeline.map((row) => (
                <div className="timeline-row" key={row.key}>
                    <span>{row.type}</span>
                    <time dateTime={row.timestamp}>{row.timestamp}</time>
                    <span className="timeline-stack">
                        <span>{row.taskId}</span>
                        <span>{row.graphId}</span>
                    </span>
                    <span className="timeline-stack">
                        <span>{row.nodeId}</span>
                        <span>{row.signal}</span>
                    </span>
                    <span className="timeline-stack timeline-message">
                        <span>{row.model}</span>
                        <span>{row.message}</span>
                    </span>
                </div>
            ))}
        </section>
    );
}
