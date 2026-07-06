/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import {
    createFileAutocompleteView,
    type FileAutocompleteState,
} from '../commands/interactive-chat-file-autocomplete.js';
import { OverlayFrame } from './OverlayFrame.js';
import { SELECTED_BG } from './overlay-theme.js';

export type FileAutocompletePanelProps = {
    readonly fileAutocomplete: FileAutocompleteState;
    readonly maxVisibleRows?: number;
    readonly showFooter?: boolean;
};

const MAX_VISIBLE = 8;
const FOOTER = 'Tab/Enter to complete, Up/Down to navigate, Esc to close';

export function FileAutocompletePanel({
    fileAutocomplete,
    maxVisibleRows = MAX_VISIBLE,
    showFooter = true,
}: FileAutocompletePanelProps): React.ReactNode {
    if (maxVisibleRows <= 0) return null;

    const view = createFileAutocompleteView(fileAutocomplete, maxVisibleRows);
    if (!view.open) return null;

    const header =
        view.totalCount > 0
            ? ` Files matching @${view.prefix} (${view.totalCount}) `
            : ` Files matching @${view.prefix} `;

    return (
        <OverlayFrame variant="panel" title={header.trim()} {...(showFooter ? { footer: FOOTER } : {})}>
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
        </OverlayFrame>
    );
}
