import type {
    ProviderPromptKeypressChoice,
    ProviderPromptKeypressState,
    ProviderPromptView,
} from './auth-provider-keypress-types';
import { clampIndex, windowStartIndex } from './list-windowing';

export function createProviderPromptView(
    state: ProviderPromptKeypressState,
    choices: readonly ProviderPromptKeypressChoice[],
    maxVisibleChoices: number,
): ProviderPromptView {
    const visibleLimit = Math.max(1, maxVisibleChoices);
    const filteredChoices = filterProviderPromptChoices(choices, state.searchQuery);
    const selectedIndex = clampIndex(state.selectedIndex, filteredChoices.length);
    const startIndex = windowStartIndex(selectedIndex, filteredChoices.length, visibleLimit);
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
