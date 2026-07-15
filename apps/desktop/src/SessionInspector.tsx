import type { DesktopApprovalEffectOutcome, DesktopApprovalEffectRecord } from './lib/agent-client.js';
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
    readonly onResolveApprovalEffect: (approvalId: string, outcome: DesktopApprovalEffectOutcome) => void;
    readonly sourceMessage: string;
    readonly sourceState: 'loading' | 'ready' | 'error';
    readonly approvalEffects: readonly DesktopApprovalEffectRecord[];
    readonly resolvingApprovalEffectIds: ReadonlySet<string>;
    readonly recoveryErrorMessage: string | undefined;
};

export function SessionInspector({
    projection,
    selectedSessionId,
    onSelectSession,
    onRefreshSessions,
    onLoadSession,
    onDecideApproval,
    onResolveApprovalEffect,
    sourceMessage,
    sourceState,
    approvalEffects,
    resolvingApprovalEffectIds,
    recoveryErrorMessage,
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
                <UtilityRailPanel
                    approvalEffects={approvalEffects}
                    projection={projection}
                    recoveryErrorMessage={recoveryErrorMessage}
                    resolvingApprovalEffectIds={resolvingApprovalEffectIds}
                    onDecideApproval={onDecideApproval}
                    onResolveApprovalEffect={onResolveApprovalEffect}
                />
            </div>
        </section>
    );
}
