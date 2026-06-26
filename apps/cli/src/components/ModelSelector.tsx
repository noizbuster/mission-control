/** @jsxImportSource @opentui/react */
import type React from 'react';
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

const cyan = '#00ffff';

export function ModelSelector({
    choices,
    searchQuery,
    selectedIndex,
    visibleCount = DEFAULT_VISIBLE_COUNT,
}: ModelSelectorProps): React.ReactNode {
    const filtered = filterChoices(choices, searchQuery);
    const totalCount = filtered.length;

    const startIndex = totalCount === 0 ? 0 : Math.min(selectedIndex, totalCount - 1);
    const windowStart = Math.floor(startIndex / visibleCount) * visibleCount;
    const windowEnd = Math.min(windowStart + visibleCount, totalCount);
    const visibleChoices = filtered.slice(windowStart, windowEnd);

    const showStart = totalCount === 0 ? 0 : windowStart + 1;
    const showEnd = totalCount === 0 ? 0 : windowEnd;

    const selectedStyle = cyan !== undefined ? { fg: cyan } : {};

    return (
        <box flexDirection="column">
            {totalCount === 0 ? (
                <text {...{ dim: true }}>No models match</text>
            ) : (
                <>
                    <text {...{ dim: true }}>
                        Showing {showStart}-{showEnd} of {totalCount}
                    </text>
                    {visibleChoices.map((choice, visibleIndex) => {
                        const choiceIndex = windowStart + visibleIndex;
                        const isSelected = choiceIndex === selectedIndex;
                        const marker = isSelected ? '>' : ' ';
                        const selection = choice.selection;
                        const modelLabel = `${selection.providerID}/${selection.modelID}`;

                        return (
                            <box key={choice.id} flexDirection="row">
                                {isSelected ? (
                                    <text {...selectedStyle} {...{ bold: true }}>
                                        {marker} {modelLabel}
                                    </text>
                                ) : (
                                    <text {...{ dim: true }}>
                                        {marker} {modelLabel}
                                    </text>
                                )}
                                <text> {choice.label}</text>
                            </box>
                        );
                    })}
                </>
            )}
        </box>
    );
}
