import { defaultModelProviderSelection, modelProviderCatalog } from '@mission-control/config';
import type {
    ModelProviderSelection,
    ProviderCapabilityStatus,
    ProviderCredentialSummary,
    ProviderExecutionCapability,
} from '@mission-control/protocol';
import type { ChangeEvent } from 'react';

type ProviderEntry = (typeof modelProviderCatalog)[number];
type ModelEntry = ProviderEntry['models'][number];

export type ProviderExecutionGate = {
    readonly canStart: boolean;
    readonly label: string;
    readonly message: string;
    readonly status: ProviderCapabilityStatus;
};

export type ProviderControlsProps = {
    readonly credentialSummaries: readonly ProviderCredentialSummary[];
    readonly credentialValue: string;
    readonly selectedProviderID: string;
    readonly selectedModelID: string;
    readonly onCredentialValueChange: (value: string) => void;
    readonly onModelIDChange: (modelID: string) => void;
    readonly onProviderSelectionChange: (selection: ModelProviderSelection) => void;
    readonly onSaveCredential: () => void;
};

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

export function getCredentialStatusLabel(
    providerID: string,
    credentialSummaries: readonly ProviderCredentialSummary[],
): string {
    const status = getCredentialStatus(providerID, credentialSummaries);
    const summary = credentialSummaries.find((entry) => entry.providerID === providerID);
    if (summary?.authenticated !== true || summary.maskedCredential === undefined) {
        return status;
    }
    return `${status} ${summary.maskedCredential}`;
}

export function getProviderExecutionGate(providerID: string): ProviderExecutionGate {
    const capability = getProvider(providerID).capability;
    const label = formatProviderCapabilityStatus(capability);
    return {
        canStart: capability.status === 'executable',
        label,
        message: capability.status === 'executable' ? 'run enabled' : `run disabled: ${label}`,
        status: capability.status,
    };
}

export function formatProviderCapabilityStatus(capability: ProviderExecutionCapability): string {
    switch (capability.status) {
        case 'executable':
            return 'can start runs';
        case 'model-discovery-only':
            return 'model discovery only';
        case 'auth-only':
            return 'auth only';
        case 'unsupported':
            return 'unsupported';
    }
}

export function ProviderExecutionStatus({ gate }: { readonly gate: ProviderExecutionGate }): React.JSX.Element {
    const executableStyle =
        gate.status === 'executable'
            ? {
                  background: 'var(--rail)',
                  borderColor: 'var(--border-strong)',
              }
            : undefined;
    return (
        <div
            className="provider-execution-status"
            data-state={gate.status}
            data-testid="provider-execution-status"
            style={executableStyle}
        >
            {gate.label}
        </div>
    );
}

export function ProviderControls({
    credentialSummaries,
    credentialValue,
    selectedProviderID,
    selectedModelID,
    onCredentialValueChange,
    onModelIDChange,
    onProviderSelectionChange,
    onSaveCredential,
}: ProviderControlsProps): React.JSX.Element {
    const selectedProvider = getProvider(selectedProviderID);
    const models = getModelsForProvider(selectedProviderID);
    const credentialStatus = getCredentialStatus(selectedProviderID, credentialSummaries);
    const credentialStatusLabel = getCredentialStatusLabel(selectedProviderID, credentialSummaries);
    const executionGate = getProviderExecutionGate(selectedProviderID);

    function handleProviderChange(event: ChangeEvent<HTMLSelectElement>): void {
        onProviderSelectionChange(resolveSelectionForProviderChange(event.currentTarget.value, selectedModelID));
    }

    function handleModelChange(event: ChangeEvent<HTMLSelectElement>): void {
        onModelIDChange(event.currentTarget.value);
    }

    function handleCredentialChange(event: ChangeEvent<HTMLInputElement>): void {
        onCredentialValueChange(event.currentTarget.value);
    }

    return (
        <section className="controls selection-controls" aria-label="provider controls">
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
            <div className="credential-status" data-state={credentialStatus} data-testid="provider-credential-status">
                {credentialStatusLabel}
            </div>
            <ProviderExecutionStatus gate={executionGate} />
            <button type="button" onClick={onSaveCredential}>
                Save credential
            </button>
        </section>
    );
}
