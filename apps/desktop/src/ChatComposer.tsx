import { modelProviderCatalog } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';

export type ChatComposerProps = {
    readonly prompt: string;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly actionMessage: string;
    readonly providerRunDisabled: boolean;
    readonly providerRunDisabledReason: string;
    readonly onPromptChange: (prompt: string) => void;
    readonly onSubmitPrompt: () => void;
    readonly onQueueFollowUp: () => void;
    readonly onSteerRun: () => void;
    readonly onInterruptRun: () => void;
    readonly onResumeRun: () => void;
};

export function ChatComposer({
    prompt,
    sessionId,
    modelProviderSelection,
    actionMessage,
    providerRunDisabled,
    providerRunDisabledReason,
    onPromptChange,
    onSubmitPrompt,
    onQueueFollowUp,
    onSteerRun,
    onInterruptRun,
    onResumeRun,
}: ChatComposerProps): React.JSX.Element {
    const activeModel = resolveActiveModelDisplay(modelProviderSelection);

    return (
        <section className="chat-composer" aria-label="desktop chat composer">
            <label className="field prompt-field">
                <span>prompt</span>
                <textarea
                    aria-label="chat prompt"
                    rows={3}
                    value={prompt}
                    onChange={(event) => onPromptChange(event.currentTarget.value)}
                />
                <div className="composer-model-selection" data-testid="composer-model-selection">
                    <span className="composer-model-name">{formatModelWithVariant(activeModel)}</span>
                    <span className="composer-provider-name">{activeModel.providerName}</span>
                </div>
            </label>
            <div className="composer-actions">
                <button type="button" disabled={providerRunDisabled} onClick={onSubmitPrompt}>
                    Submit prompt
                </button>
                <button type="button" disabled={providerRunDisabled} onClick={onQueueFollowUp}>
                    Queue follow-up
                </button>
                <button type="button" disabled={providerRunDisabled} onClick={onSteerRun}>
                    Steer
                </button>
                <button type="button" onClick={onInterruptRun}>
                    Interrupt
                </button>
                <button type="button" onClick={onResumeRun}>
                    Resume
                </button>
            </div>
            <div className="composer-meta">
                <span>{sessionId.length > 0 ? sessionId : 'session required'}</span>
                <span>{actionMessage}</span>
                {providerRunDisabled ? (
                    <span data-testid="composer-provider-run-state">{providerRunDisabledReason}</span>
                ) : null}
            </div>
        </section>
    );
}

type ActiveModelDisplay = {
    readonly modelName: string;
    readonly providerName: string;
    readonly variantName?: string;
};

function resolveActiveModelDisplay(selection: ModelProviderSelection): ActiveModelDisplay {
    const provider = modelProviderCatalog.find((entry) => entry.id === selection.providerID);
    const model = provider?.models.find((entry) => entry.id === selection.modelID);
    const variant =
        selection.variantID === undefined
            ? model?.variants?.[0]
            : model?.variants?.find((entry) => entry.id === selection.variantID);
    return {
        modelName: model?.name ?? selection.modelID,
        providerName: provider?.name ?? selection.providerID,
        ...(variant !== undefined ? { variantName: variant.name } : {}),
        ...(variant === undefined && selection.variantID !== undefined ? { variantName: selection.variantID } : {}),
    };
}

function formatModelWithVariant(model: ActiveModelDisplay): string {
    if (model.variantName === undefined) {
        return model.modelName;
    }
    return `${model.modelName}(${model.variantName})`;
}
