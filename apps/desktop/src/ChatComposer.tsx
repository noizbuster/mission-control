import type { ModelProviderSelection } from '@mission-control/protocol';

export type ChatComposerProps = {
    readonly prompt: string;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly actionMessage: string;
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
    onPromptChange,
    onSubmitPrompt,
    onQueueFollowUp,
    onSteerRun,
    onInterruptRun,
    onResumeRun,
}: ChatComposerProps): React.JSX.Element {
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
            </label>
            <div className="composer-actions">
                <button type="button" onClick={onSubmitPrompt}>
                    Submit prompt
                </button>
                <button type="button" onClick={onQueueFollowUp}>
                    Queue follow-up
                </button>
                <button type="button" onClick={onSteerRun}>
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
                <span>
                    {modelProviderSelection.providerID}/{modelProviderSelection.modelID}
                </span>
                <span>{actionMessage}</span>
            </div>
        </section>
    );
}
