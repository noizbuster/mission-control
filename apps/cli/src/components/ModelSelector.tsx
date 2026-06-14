import { Box, Text } from 'ink';
import type { ModelChoice } from '../commands/interactive-chat-model.js';

export type ModelSelectorProps = {
    readonly choices: readonly ModelChoice[];
    readonly searchQuery: string;
    readonly selectedIndex: number;
    readonly visibleCount?: number;
};

const DEFAULT_VISIBLE_COUNT = 10;

function filterChoices(choices: readonly ModelChoice[], query: string): readonly ModelChoice[] {
    const normalized = query.toLowerCase();
    if (normalized.length === 0) {
        return choices;
    }
    return choices.filter((choice) => choice.label.toLowerCase().includes(normalized));
}

export function ModelSelector({
    choices,
    searchQuery,
    selectedIndex,
    visibleCount = DEFAULT_VISIBLE_COUNT,
}: ModelSelectorProps): React.JSX.Element {
    const filtered = filterChoices(choices, searchQuery);
    const totalCount = filtered.length;

    const startIndex = totalCount === 0 ? 0 : Math.min(selectedIndex, totalCount - 1);
    const windowStart = Math.floor(startIndex / visibleCount) * visibleCount;
    const windowEnd = Math.min(windowStart + visibleCount, totalCount);
    const visibleChoices = filtered.slice(windowStart, windowEnd);

    const showStart = totalCount === 0 ? 0 : windowStart + 1;
    const showEnd = totalCount === 0 ? 0 : windowEnd;

    return (
        <Box flexDirection="column">
            {totalCount === 0 ? (
                <Text dimColor>No models match</Text>
            ) : (
                <>
                    <Text dimColor>
                        Showing {showStart}-{showEnd} of {totalCount}
                    </Text>
                    {visibleChoices.map((choice, visibleIndex) => {
                        const choiceIndex = windowStart + visibleIndex;
                        const isSelected = choiceIndex === selectedIndex;
                        const marker = isSelected ? '>' : ' ';
                        const selection = choice.selection;
                        const modelLabel = `${selection.providerID}/${selection.modelID}`;

                        return (
                            <Text key={choice.id}>
                                {isSelected ? (
                                    <Text color="cyan" bold>
                                        {marker} {modelLabel}
                                    </Text>
                                ) : (
                                    <Text dimColor>
                                        {marker} {modelLabel}
                                    </Text>
                                )}
                                <Text> {choice.label}</Text>
                            </Text>
                        );
                    })}
                </>
            )}
        </Box>
    );
}
