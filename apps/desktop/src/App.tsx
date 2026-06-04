import { defaultModelProviderSelection, modelProviderCatalog } from '@mission-control/config';
import type {
    AbgNodeModelOptions,
    AgentEvent,
    ModelProviderSelection,
    ProviderCredentialSummary,
} from '@mission-control/protocol';
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';
import { createMockDesktopAgentClient } from './lib/agent-client.js';

export type AppProps = {
    readonly initialSessionId?: string;
    readonly initialEvents?: readonly AgentEvent[];
    readonly initialCredentialSummaries?: readonly ProviderCredentialSummary[];
};

type ProviderEntry = (typeof modelProviderCatalog)[number];
type ModelEntry = ProviderEntry['models'][number];

function getProvider(providerID: string): ProviderEntry {
    const provider = modelProviderCatalog.find((entry) => entry.id === providerID);
    if (provider !== undefined) {
        return provider;
    }
    const fallbackProvider = modelProviderCatalog.find(
        (entry) => entry.id === defaultModelProviderSelection.providerID,
    );
    if (fallbackProvider !== undefined) {
        return fallbackProvider;
    }
    throw new Error('Default model provider is not available in the catalog');
}

export function getModelsForProvider(providerID: string): readonly ModelEntry[] {
    return getProvider(providerID).models;
}

export function resolveSelectionForProviderChange(providerID: string, currentModelID: string): ModelProviderSelection {
    const provider = getProvider(providerID);
    const model = provider.models.find((entry) => entry.id === currentModelID);
    return {
        providerID: provider.id,
        modelID: model?.id ?? provider.defaultModelID,
    };
}

export function getCredentialStatus(
    providerID: string,
    credentialSummaries: readonly ProviderCredentialSummary[],
): 'credential configured' | 'credential missing' {
    const summary = credentialSummaries.find((entry) => entry.providerID === providerID);
    return summary?.authenticated === true ? 'credential configured' : 'credential missing';
}

function formatModelSelection(modelProviderSelection: ModelProviderSelection | undefined): string {
    if (modelProviderSelection === undefined) {
        return '';
    }
    return `${modelProviderSelection.providerID}/${modelProviderSelection.modelID}`;
}

function formatAbgModel(model: AbgNodeModelOptions | undefined): string {
    if (model === undefined) {
        return '';
    }
    return `${model.providerID}/${model.modelID}${model.variantID !== undefined ? `/${model.variantID}` : ''}`;
}

function formatEventModel(event: AgentEvent): string {
    const abgModel = formatAbgModel(event.abg?.model);
    return abgModel.length > 0 ? abgModel : formatModelSelection(event.modelProviderSelection);
}

export function App({
    initialSessionId,
    initialEvents = [],
    initialCredentialSummaries = [],
}: AppProps): React.JSX.Element {
    const client = useMemo(() => createMockDesktopAgentClient(), []);
    const [sessionId, setSessionId] = useState<string>(initialSessionId ?? 'not started');
    const [events, setEvents] = useState<readonly AgentEvent[]>(initialEvents);
    const [credentialSummaries, setCredentialSummaries] =
        useState<readonly ProviderCredentialSummary[]>(initialCredentialSummaries);
    const [credentialValue, setCredentialValue] = useState<string>('');
    const [selectedProviderID, setSelectedProviderID] = useState<string>(defaultModelProviderSelection.providerID);
    const [selectedModelID, setSelectedModelID] = useState<string>(defaultModelProviderSelection.modelID);
    const selectedProvider = getProvider(selectedProviderID);
    const models = getModelsForProvider(selectedProviderID);
    const nativeStatus = events.at(-1)?.nativeSidecarStatus ?? 'mock';
    const credentialStatus = getCredentialStatus(selectedProviderID, credentialSummaries);
    const modelProviderSelection: ModelProviderSelection = {
        providerID: selectedProviderID,
        modelID: selectedModelID,
    };

    useEffect(() => {
        let isMounted = true;
        client.listProviderCredentials().then((summaries) => {
            if (isMounted) {
                setCredentialSummaries(summaries);
            }
        });
        return () => {
            isMounted = false;
        };
    }, [client]);

    function handleProviderChange(event: ChangeEvent<HTMLSelectElement>): void {
        const selection = resolveSelectionForProviderChange(event.currentTarget.value, selectedModelID);
        setSelectedProviderID(selection.providerID);
        setSelectedModelID(selection.modelID);
    }

    function handleModelChange(event: ChangeEvent<HTMLSelectElement>): void {
        setSelectedModelID(event.currentTarget.value);
    }

    function handleCredentialChange(event: ChangeEvent<HTMLInputElement>): void {
        setCredentialValue(event.currentTarget.value);
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
                modelProviderSelection,
            },
        ]);
    }

    async function runDemoTask(): Promise<void> {
        const activeSessionId = sessionId === 'not started' ? (await client.startDemoSession()).id : sessionId;
        setSessionId(activeSessionId);
        setEvents(await client.runDemoTask(activeSessionId, modelProviderSelection));
    }

    return (
        <main className="shell">
            <header className="topbar">
                <div>
                    <h1>mission-control</h1>
                    <p className="session">session {sessionId}</p>
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

            <section className="controls selection-controls" aria-label="demo controls">
                <label className="field">
                    <span>provider</span>
                    <select aria-label="provider" value={selectedProviderID} onChange={handleProviderChange}>
                        {modelProviderCatalog.map((provider) => (
                            <option key={provider.id} value={provider.id}>
                                {provider.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>model</span>
                    <select aria-label="model" value={selectedModelID} onChange={handleModelChange}>
                        {models.map((model) => (
                            <option key={model.id} value={model.id}>
                                {model.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field credential-field">
                    <span>{selectedProvider.authLabel}</span>
                    <input
                        aria-label={selectedProvider.authLabel}
                        autoComplete="off"
                        type="password"
                        value={credentialValue}
                        onChange={handleCredentialChange}
                    />
                </label>
                <div
                    className="credential-status"
                    data-state={credentialStatus}
                    data-testid="provider-credential-status"
                >
                    {credentialStatus}
                </div>
                <button type="button" onClick={saveCredential}>
                    Save credential
                </button>
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
                    <span>graph</span>
                    <span>node</span>
                    <span>signal</span>
                    <span>timestamp</span>
                    <span>message</span>
                    <span>model</span>
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
                        <span>{event.abg?.graphId ?? ''}</span>
                        <span>{event.abg?.nodeId ?? ''}</span>
                        <span>{event.abg?.signalType ?? ''}</span>
                        <time dateTime={event.timestamp}>{event.timestamp}</time>
                        <span>{event.message ?? ''}</span>
                        <span>{formatEventModel(event)}</span>
                        <span>{event.taskId ?? ''}</span>
                        <span>{event.nativeSidecarStatus ?? 'mock'}</span>
                    </div>
                ))}
            </section>
        </main>
    );
}

function replaceCredentialSummary(
    current: readonly ProviderCredentialSummary[],
    summary: ProviderCredentialSummary,
): readonly ProviderCredentialSummary[] {
    return [...current.filter((entry) => entry.providerID !== summary.providerID), summary];
}
