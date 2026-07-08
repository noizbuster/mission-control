import type {
    ProviderPromptKeypressChoice,
    ProviderPromptKeypressState,
    ProviderPromptView,
} from './auth-provider-keypress-types.js';

export function createProviderPromptView(
    state: ProviderPromptKeypressState,
    choices: readonly ProviderPromptKeypressChoice[],
    maxVisibleChoices: number,
): ProviderPromptView {
    const visibleLimit = Math.max(1, maxVisibleChoices);
    const filteredChoices = filterProviderPromptChoices(choices, state.searchQuery);
    const selectedIndex = clampSelectedIndex(state.selectedIndex, filteredChoices.length);
    const startIndex = getWindowStartIndex(selectedIndex, filteredChoices.length, visibleLimit);
    const endIndex = Math.min(filteredChoices.length, startIndex + visibleLimit);
    return {
        filteredChoices,
        visibleChoices: filteredChoices.slice(startIndex, endIndex),
        selectedIndex,
        startIndex,
        endIndex,
        totalCount: filteredChoices.length,
        searchQuery: state.searchQuery,
    };
}

export function filterProviderPromptChoices(
    choices: readonly ProviderPromptKeypressChoice[],
    searchQuery: string,
): readonly ProviderPromptKeypressChoice[] {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
        return choices;
    }
    return choices.filter(
        (choice) =>
            choice.id.toLowerCase().includes(normalizedQuery) || choice.name.toLowerCase().includes(normalizedQuery),
    );
}

function clampSelectedIndex(selectedIndex: number, choiceCount: number): number {
    if (choiceCount <= 0) {
        return 0;
    }
    return Math.min(Math.max(selectedIndex, 0), choiceCount - 1);
}

function getWindowStartIndex(selectedIndex: number, choiceCount: number, visibleLimit: number): number {
    if (choiceCount <= visibleLimit) {
        return 0;
    }
    const centeredStart = selectedIndex - Math.floor(visibleLimit / 2);
    return Math.min(Math.max(centeredStart, 0), choiceCount - visibleLimit);
}
