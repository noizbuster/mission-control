import type { SessionInspectorProjection } from './lib/session-inspector.js';

export type SessionInspectorProps = {
    readonly projection: SessionInspectorProjection;
    readonly selectedSessionId: string;
    readonly onSelectSession: (sessionId: string) => void;
    readonly onRefreshSessions: () => void;
    readonly onLoadSession: () => void;
    readonly onDecideApproval: (approvalId: string, state: 'approved' | 'denied') => void;
    readonly sourceMessage: string;
    readonly sourceState: 'loading' | 'ready' | 'error';
};

export function SessionInspector({
    projection,
    selectedSessionId,
    onSelectSession,
    onRefreshSessions,
    onLoadSession,
    onDecideApproval,
    sourceMessage,
    sourceState,
}: SessionInspectorProps): React.JSX.Element {
    return (
        <section className="inspector" aria-label="read-only session inspector">
            <header className="inspector-toolbar">
                <label className="field">
                    <span>session</span>
                    <select
                        aria-label="session"
                        value={selectedSessionId}
                        onChange={(event) => onSelectSession(event.currentTarget.value)}
                    >
                        <option value="">No session selected</option>
                        {projection.sessions.map((session) => (
                            <option key={session.sessionId} value={session.sessionId}>
                                {session.sessionId} ({session.state})
                            </option>
                        ))}
                    </select>
                </label>
                <button type="button" onClick={onRefreshSessions}>
                    Refresh sessions
                </button>
                <button type="button" onClick={onLoadSession}>
                    Load session
                </button>
                <div className="source-status" data-state={sourceState}>
                    {sourceMessage}
                </div>
            </header>

            <div className="workspace-layout">
                <aside className="session-list" aria-label="sessions">
                    <h2>Sessions</h2>
                    {projection.sessions.length === 0 ? <p className="empty-state">No session logs</p> : null}
                    {projection.sessions.map((session) => (
                        <button
                            className="session-item"
                            data-state={session.state}
                            key={session.sessionId}
                            type="button"
                            onClick={() => onSelectSession(session.sessionId)}
                        >
                            <span>{session.sessionId}</span>
                            <span>{session.eventCount} events</span>
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

                <div className="center-stack">
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

                    <section className="output-panel" aria-label="patch and command output">
                        <div>
                            <h2>Patch text</h2>
                            {projection.patches.length === 0 ? <p className="empty-state">No patch text</p> : null}
                            {projection.patches.map((patch) => (
                                <pre key={patch.key}>
                                    {patch.filePath} {patch.changeKind}
                                    {'\n'}
                                    {patch.text}
                                </pre>
                            ))}
                        </div>
                        <div>
                            <h2>Command output</h2>
                            {projection.commands.length === 0 ? <p className="empty-state">No command output</p> : null}
                            {projection.commands.map((command) => (
                                <pre key={command.key}>
                                    {command.command}
                                    {'\n'}
                                    status: {command.status} exit: {command.exit}
                                    {'\n'}
                                    cwd: {command.cwd}
                                </pre>
                            ))}
                        </div>
                        <div>
                            <h2>Coding replay</h2>
                            {projection.codingSteps.length === 0 ? (
                                <p className="empty-state">No coding replay</p>
                            ) : null}
                            {projection.codingSteps.map((step) => (
                                <div className="compact-row" key={step.key}>
                                    <strong>{step.kind}</strong>
                                    <span>{step.status}</span>
                                    <span>{step.subject}</span>
                                    <span>{step.detail}</span>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h2>Tool outcomes</h2>
                            {projection.toolOutcomes.length === 0 ? (
                                <p className="empty-state">No tool outcomes</p>
                            ) : null}
                            {projection.toolOutcomes.map((tool) => (
                                <div className="compact-row" key={tool.key}>
                                    <strong>{tool.toolId}</strong>
                                    <span>{tool.status}</span>
                                    <span>{tool.timestamps}</span>
                                    <span>{tool.detail}</span>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h2>Diagnostics</h2>
                            {projection.diagnostics.length === 0 ? <p className="empty-state">No diagnostics</p> : null}
                            {projection.diagnostics.map((diagnostic) => (
                                <div
                                    className="compact-row"
                                    key={`${diagnostic.code}-${diagnostic.lineNumber ?? 'file'}`}
                                >
                                    <strong>{diagnostic.code}</strong>
                                    <span>{diagnostic.lineNumber ?? ''}</span>
                                    <span>{diagnostic.message}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                <aside className="utility-rail" aria-label="graph inspector">
                    <h2>Graph inspector</h2>
                    {projection.graphs.length === 0 ? <p className="empty-state">No graph snapshot</p> : null}
                    {projection.graphs.map((graph) => (
                        <div className="graph-block" key={graph.graphId}>
                            <strong>{graph.graphId}</strong>
                            <span>{graph.status}</span>
                            {graph.nodes.map((node) => (
                                <div className="compact-row" key={node.nodeId}>
                                    <span>{node.nodeId}</span>
                                    <span>{node.status}</span>
                                    <span>{node.lastSignalType ?? ''}</span>
                                </div>
                            ))}
                        </div>
                    ))}
                    <h2>Approval queue</h2>
                    {projection.approvals.length === 0 ? <p className="empty-state">No approvals</p> : null}
                    {projection.approvals.map((approval) => (
                        <div className="approval-item" key={approval.key}>
                            <div className="compact-row">
                                <strong>{approval.approvalId}</strong>
                                <span>{approval.state}</span>
                                <span>{approval.subject}</span>
                                <span>{approval.reason}</span>
                            </div>
                            {approval.preview !== undefined ? (
                                <pre className="approval-preview">
                                    {approval.preview.summary}
                                    {'\n'}
                                    {approval.preview.body}
                                </pre>
                            ) : null}
                            {approval.state === 'pending' ? (
                                <div className="approval-actions">
                                    <button
                                        type="button"
                                        onClick={() => onDecideApproval(approval.approvalId, 'approved')}
                                    >
                                        Approve
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onDecideApproval(approval.approvalId, 'denied')}
                                    >
                                        Deny
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    ))}
                </aside>
            </div>
        </section>
    );
}
