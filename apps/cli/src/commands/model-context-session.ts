import {
    resolveAutoCompactThreshold,
    resolveEffectiveContextLimit,
    shouldAutoCompact,
} from '@mission-control/config';
import {
    type LocalSessionEventStore,
    type ObservabilityRedactor,
    type ProviderAdapter,
    type ProviderAuthStore,
    TuiStores,
} from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io';
import { startCompactionTurn } from './interactive-chat-compact';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent';

export async function loadEffectiveContextLimit(
    selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
): Promise<number | undefined> {
    const prefs = await new TuiStores.TuiLocalPreferencesStore().getPreferences();
    return resolveEffectiveContextLimit(selection, prefs.modelContextPrefs);
}

export async function maybeStartAutoCompaction(input: {
    readonly usedTokens: number | undefined;
    readonly selection: ModelProviderSelection;
    readonly sessionId: string | undefined;
    readonly sessionStore: LocalSessionEventStore | undefined;
    readonly provider: ProviderAdapter | undefined;
    readonly output: ChatOutput;
    readonly workspaceRoot?: string;
    readonly observeStoredEvent?: (event: import('@mission-control/protocol').AgentEvent) => void;
    readonly authStore?: ProviderAuthStore;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<ActiveCodingAgentTurn | undefined> {
    if (
        input.sessionId === undefined ||
        input.sessionStore === undefined ||
        input.provider === undefined ||
        input.usedTokens === undefined
    ) {
        return undefined;
    }
    const prefs = await new TuiStores.TuiLocalPreferencesStore().getPreferences();
    const contextLimit = resolveEffectiveContextLimit(input.selection, prefs.modelContextPrefs);
    const threshold = resolveAutoCompactThreshold(input.selection, prefs.modelContextPrefs);
    if (!shouldAutoCompact({ usedTokens: input.usedTokens, contextLimit, threshold })) {
        return undefined;
    }
    input.output.write(
        `Auto-compacting session (${input.usedTokens}/${contextLimit ?? '?'} tokens ≥ ${Math.round(threshold * 100)}%)…\n`,
    );
    return startCompactionTurn({
        sessionId: input.sessionId,
        store: input.sessionStore,
        provider: input.provider,
        modelProviderSelection: input.selection,
        output: input.output,
        ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
        ...(input.observeStoredEvent !== undefined ? { observeStoredEvent: input.observeStoredEvent } : {}),
        ...(input.authStore !== undefined ? { authStore: input.authStore } : {}),
    });
}
