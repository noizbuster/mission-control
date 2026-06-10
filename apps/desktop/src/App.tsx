import { defaultModelProviderSelection } from '@mission-control/config';
import type { ModelProviderSelection, ProviderCredentialSummary } from '@mission-control/protocol';
import { useEffect, useMemo, useState } from 'react';
import { ChatComposer } from './ChatComposer.js';
import {
    createTauriDesktopAgentClient,
    type DesktopAgentClient,
    type DesktopSessionLog,
    type DesktopSessionSummary,
} from './lib/agent-client.js';
import { projectSessionInspector } from './lib/session-inspector.js';
import { ProviderControls } from './ProviderControls.js';
import { SessionInspector } from './SessionInspector.js';
import { useDesktopWriteActions } from './useDesktopWriteActions.js';

export { getCredentialStatus, getModelsForProvider, resolveSelectionForProviderChange } from './ProviderControls.js';

export type AppProps = {
    readonly initialSessionId?: string;
    readonly initialCredentialSummaries?: readonly ProviderCredentialSummary[];
    readonly initialSessionSummaries?: readonly DesktopSessionSummary[];
    readonly initialSessionLog?: DesktopSessionLog;
    readonly client?: DesktopAgentClient;
};

type SessionSourceState = 'loading' | 'ready' | 'error';

export function App({
    initialSessionId,
    initialCredentialSummaries = [],
    initialSessionSummaries = [],
    initialSessionLog,
    client: providedClient,
}: AppProps): React.JSX.Element {
    const client = useMemo(() => providedClient ?? createTauriDesktopAgentClient(), [providedClient]);
    const initialSelectedSessionId = initialSessionId ?? initialSessionLog?.sessionId ?? '';
    const [sessionId, setSessionId] = useState<string>(initialSelectedSessionId);
    const [sessionSummaries, setSessionSummaries] = useState<readonly DesktopSessionSummary[]>(initialSessionSummaries);
    const [sessionLog, setSessionLog] = useState<DesktopSessionLog | undefined>(initialSessionLog);
    const hasInitialSessionSource = initialSessionSummaries.length > 0 || initialSessionLog !== undefined;
    const [sourceState, setSourceState] = useState<SessionSourceState>(hasInitialSessionSource ? 'ready' : 'loading');
    const [sourceMessage, setSourceMessage] = useState<string>(
        hasInitialSessionSource ? 'read-only session source' : 'Loading session catalog',
    );
    const [credentialSummaries, setCredentialSummaries] =
        useState<readonly ProviderCredentialSummary[]>(initialCredentialSummaries);
    const [credentialValue, setCredentialValue] = useState<string>('');
    const [selectedProviderID, setSelectedProviderID] = useState<string>(defaultModelProviderSelection.providerID);
    const [selectedModelID, setSelectedModelID] = useState<string>(defaultModelProviderSelection.modelID);
    const selectedSessionLog = sessionLog?.sessionId === sessionId ? sessionLog : undefined;
    const displayedSourceStatus = sessionSourceStatus(sourceState, sourceMessage, selectedSessionLog);
    const events = selectedSessionLog?.envelopes.map((envelope) => envelope.event) ?? [];
    const nativeStatus = events.at(-1)?.nativeSidecarStatus ?? 'mock';
    const modelProviderSelection: ModelProviderSelection = {
        providerID: selectedProviderID,
        modelID: selectedModelID,
    };
    const inspectorProjection = projectSessionInspector({
        sessions: sessionSummaries,
        selectedLog: selectedSessionLog,
    });
    const writeActions = useDesktopWriteActions({
        client,
        sessionId,
        modelProviderSelection,
        setSessionId,
        setSessionSummaries,
        setSessionLog,
        setSourceState,
        setSourceMessage,
    });

    useEffect(() => {
        let isMounted = true;
        client.listProviderCredentials().then(
            (summaries) => {
                if (isMounted) {
                    setCredentialSummaries(summaries);
                }
            },
            (error: unknown) => {
                if (isMounted) {
                    setSourceMessage(`credential source unavailable: ${errorMessage(error)}`);
                }
            },
        );
        client.listSessions().then(
            (sessions) => {
                if (isMounted) {
                    setSessionSummaries(sessions);
                    setSourceState('ready');
                    setSourceMessage(`${sessions.length} session logs available`);
                }
            },
            (error: unknown) => {
                if (isMounted) {
                    setSourceState('error');
                    setSourceMessage(`session source unavailable: ${errorMessage(error)}`);
                }
            },
        );
        return () => {
            isMounted = false;
        };
    }, [client]);

    function handleProviderSelectionChange(selection: ModelProviderSelection): void {
        setSelectedProviderID(selection.providerID);
        setSelectedModelID(selection.modelID);
    }

    async function saveCredential(): Promise<void> {
        const apiKey = credentialValue.trim();
        if (apiKey.length === 0) {
            return;
        }
        const summary = await client.saveProviderCredential({
            providerID: selectedProviderID,
            apiKey,
        });
        setCredentialSummaries((current) => replaceCredentialSummary(current, summary));
        setCredentialValue('');
    }

    async function refreshSessions(): Promise<void> {
        try {
            setSourceState('loading');
            setSourceMessage('Loading session catalog');
            const sessions = await client.listSessions();
            setSessionSummaries(sessions);
            setSourceState('ready');
            setSourceMessage(`${sessions.length} session logs available`);
        } catch (error: unknown) {
            setSourceState('error');
            setSourceMessage(`session source unavailable: ${errorMessage(error)}`);
        }
    }

    async function loadSelectedSession(): Promise<void> {
        if (sessionId.length === 0) {
            setSourceState('error');
            setSourceMessage('select a session');
            return;
        }
        try {
            setSourceState('loading');
            setSourceMessage('Loading session events');
            const [log, snapshot] = await Promise.all([
                client.readSessionEvents(sessionId),
                client.readSessionSnapshot(sessionId),
            ]);
            setSessionLog(log);
            setSessionId(log.sessionId);
            setSourceState(log.state === 'corrupt' ? 'error' : 'ready');
            setSourceMessage(`${snapshot.eventCount} events, ${snapshot.graphIds.length} graphs`);
        } catch (error: unknown) {
            setSourceState('error');
            setSourceMessage(`session load failed: ${errorMessage(error)}`);
        }
    }

    return (
        <main className="shell">
            <header className="topbar">
                <div>
                    <h1>mission-control</h1>
                    <p className="session">session {sessionId.length > 0 ? sessionId : 'not selected'}</p>
                </div>
                <div className="status-group">
                    <div className="status" data-testid="native-status">
                        native sidecar {nativeStatus}
                    </div>
                    <div className="status model-status" data-testid="active-model">
                        model {modelProviderSelection.providerID}/{modelProviderSelection.modelID}
                    </div>
                </div>
            </header>

            <ProviderControls
                credentialSummaries={credentialSummaries}
                credentialValue={credentialValue}
                selectedProviderID={selectedProviderID}
                selectedModelID={selectedModelID}
                onCredentialValueChange={setCredentialValue}
                onModelIDChange={setSelectedModelID}
                onProviderSelectionChange={handleProviderSelectionChange}
                onSaveCredential={saveCredential}
            />

            <ChatComposer
                actionMessage={writeActions.actionMessage}
                modelProviderSelection={modelProviderSelection}
                prompt={writeActions.promptValue}
                sessionId={sessionId}
                onInterruptRun={() => {
                    void writeActions.interruptRun();
                }}
                onPromptChange={writeActions.setPromptValue}
                onQueueFollowUp={() => {
                    void writeActions.queueFollowUp();
                }}
                onResumeRun={() => {
                    void writeActions.resumeRun();
                }}
                onSteerRun={() => {
                    void writeActions.steerRun();
                }}
                onSubmitPrompt={() => {
                    void writeActions.submitPrompt();
                }}
            />

            <SessionInspector
                projection={inspectorProjection}
                selectedSessionId={sessionId}
                sourceMessage={displayedSourceStatus.message}
                sourceState={displayedSourceStatus.state}
                onDecideApproval={(approvalId, state) => {
                    void writeActions.decideApproval(approvalId, state);
                }}
                onLoadSession={loadSelectedSession}
                onRefreshSessions={refreshSessions}
                onSelectSession={setSessionId}
            />
        </main>
    );
}

function replaceCredentialSummary(
    current: readonly ProviderCredentialSummary[],
    summary: ProviderCredentialSummary,
): readonly ProviderCredentialSummary[] {
    return [...current.filter((entry) => entry.providerID !== summary.providerID), summary];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sessionSourceStatus(
    state: SessionSourceState,
    message: string,
    selectedSessionLog: DesktopSessionLog | undefined,
): {
    readonly state: SessionSourceState;
    readonly message: string;
} {
    if (selectedSessionLog?.state !== 'corrupt') {
        return { state, message };
    }
    const diagnosticCount = selectedSessionLog.diagnostics.length;
    const suffix = diagnosticCount === 1 ? 'diagnostic' : 'diagnostics';
    return {
        state: 'error',
        message: `corrupt session: ${diagnosticCount} ${suffix}`,
    };
}
