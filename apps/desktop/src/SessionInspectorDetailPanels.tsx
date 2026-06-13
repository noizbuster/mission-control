import type { SessionInspectorProjection } from './lib/session-inspector.js';

export function OutputPanelSection({
    projection,
}: {
    readonly projection: SessionInspectorProjection;
}): React.JSX.Element {
    return (
        <section className="output-panel" aria-label="patch and command output">
            <div>
                <h2>Patch text</h2>
                {projection.patches.length === 0 ? <p className="empty-state">No patch text</p> : null}
                {projection.patches.map((patch) => (
                    <pre key={patch.key}>
                        {patch.eventType} {patch.timestamp}
                        {'\n'}
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
                        {command.eventType} {command.timestamp}
                        {'\n'}
                        {command.command}
                        {'\n'}
                        {command.message}
                        {'\n'}
                        status: {command.status} exit: {command.exit}
                        {'\n'}
                        cwd: {command.cwd}
                    </pre>
                ))}
            </div>
            <div>
                <h2>Coding replay</h2>
                {projection.codingSteps.length === 0 ? <p className="empty-state">No coding replay</p> : null}
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
                {projection.toolOutcomes.length === 0 ? <p className="empty-state">No tool outcomes</p> : null}
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
                    <div className="compact-row" key={`${diagnostic.code}-${diagnostic.lineNumber ?? 'file'}`}>
                        <strong>{diagnostic.code}</strong>
                        <span>{diagnostic.lineNumber ?? ''}</span>
                        <span>{diagnostic.message}</span>
                    </div>
                ))}
            </div>
        </section>
    );
}

export function UtilityRailPanel({
    projection,
    onDecideApproval,
}: {
    readonly projection: SessionInspectorProjection;
    readonly onDecideApproval: (approvalId: string, state: 'approved' | 'denied') => void;
}): React.JSX.Element {
    return (
        <aside className="utility-rail" aria-label="graph inspector">
            <h2>Trust status</h2>
            <div className="compact-row">
                <strong>{projection.sessionTree?.workspaceTrust || 'unknown'}</strong>
                <span>{projection.sessionTree?.trustedRoot || 'No trusted root'}</span>
                <span>{projection.sessionTree?.cwd || 'No cwd'}</span>
            </div>
            <h2>Session tree</h2>
            {projection.sessionTree === undefined ? <p className="empty-state">No session tree</p> : null}
            {projection.sessionTree !== undefined ? (
                <>
                    <div className="compact-row">
                        <strong>{projection.sessionTree.sessionName || projection.selectedLog?.sessionId || ''}</strong>
                        <span>{projection.sessionTree.parentSessionId}</span>
                        <span>{projection.sessionTree.activeLeafId}</span>
                        <span>
                            entries {projection.sessionTree.entryCount} branches {projection.sessionTree.branchCount}
                        </span>
                    </div>
                    {projection.sessionTree.rows.map((row) => (
                        <div className="compact-row" key={row.key}>
                            <strong>{row.entryId}</strong>
                            <span>{row.parentEntryId}</span>
                            <span>{row.active ? 'active' : row.eventType}</span>
                            <span>{row.message}</span>
                        </div>
                    ))}
                </>
            ) : null}
            <h2>Session stats</h2>
            {projection.stats === undefined ? <p className="empty-state">No session stats</p> : null}
            {projection.stats !== undefined ? (
                <div className="compact-row">
                    <strong>{projection.stats.eventCount} events</strong>
                    <span>{projection.stats.pendingApprovalCount} pending approvals</span>
                    <span>{projection.stats.blockedRunCount} blocked runs</span>
                    <span>{projection.stats.commandEventCount} command events</span>
                    <span>{projection.stats.diffEventCount} diff events</span>
                    <span>{projection.stats.toolOutcomeCount} tool outcomes</span>
                </div>
            ) : null}
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
                            <button type="button" onClick={() => onDecideApproval(approval.approvalId, 'approved')}>
                                Approve
                            </button>
                            <button type="button" onClick={() => onDecideApproval(approval.approvalId, 'denied')}>
                                Deny
                            </button>
                        </div>
                    ) : null}
                </div>
            ))}
        </aside>
    );
}
