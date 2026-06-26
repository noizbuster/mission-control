/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import {
    type FileAutocompleteState,
    createFileAutocompleteView,
} from '../commands/interactive-chat-file-autocomplete.js';

export type FileAutocompletePanelProps = {
    readonly fileAutocomplete: FileAutocompleteState;
};

const MAX_VISIBLE = 8;
const SELECTED_BG = '#0000ff';
const HEADER_FG = '#00ffff';

export function FileAutocompletePanel({ fileAutocomplete }: FileAutocompletePanelProps): React.ReactNode {
    const view = createFileAutocompleteView(fileAutocomplete, MAX_VISIBLE);
    if (!view.open) return null;

    const header = view.totalCount > 0
        ? ` Files matching @${view.prefix} (${view.totalCount}) `
        : ` Files matching @${view.prefix} `;

    return (
        <box flexDirection="column" marginTop={1}>
            <text fg={HEADER_FG} attributes={TextAttributes.BOLD}>{header}</text>
            {view.empty ? (
                <text attributes={TextAttributes.DIM}> no files match</text>
            ) : (
                view.visibleMatches.map((match, index) => {
                    const globalIndex = view.startIndex + index;
                    const isSelected = globalIndex === view.selectedIndex;
                    const marker = match.isDirectory ? '/' : ' ';
                    const selectedBg = isSelected ? { bg: SELECTED_BG } : {};
                    return (
                        <box key={match.name} flexDirection="row">
                            <text {...selectedBg}>
                                {isSelected ? '> ' : '  '}
                                {marker}
                                {match.name}
                            </text>
                        </box>
                    );
                })
            )}
            <text attributes={TextAttributes.DIM}>
                Tab/Enter to complete, Up/Down to navigate, Esc to close
            </text>
        </box>
    );
}
