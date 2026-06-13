import type { SessionInspectorProjection } from './lib/session-inspector.js';
import { OutputPanelSection, UtilityRailPanel } from './SessionInspectorDetailPanels.js';
import { SessionListPanel, TimelinePanelSection } from './SessionInspectorPanels.js';
import './SessionInspector.css';

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
                <SessionListPanel
                    projection={projection}
                    selectedSessionId={selectedSessionId}
                    onSelectSession={onSelectSession}
                />
                <div className="center-stack">
                    <TimelinePanelSection projection={projection} />
                    <OutputPanelSection projection={projection} />
                </div>
                <UtilityRailPanel projection={projection} onDecideApproval={onDecideApproval} />
            </div>
        </section>
    );
}
