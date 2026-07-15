import { TextAttributes } from '@opentui/core';
import { For, type JSX } from 'solid-js';
import { createFileAutocompleteView, type FileAutocompleteState } from '../state/interactive-chat-file-autocomplete';
import { OverlayFrame } from './OverlayFrame';
import { SELECTED_BG } from './overlay-theme';

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
}: FileAutocompletePanelProps): JSX.Element | null {
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
                <For each={view.visibleMatches}>
                    {(match, index) => {
                        const globalIndex = view.startIndex + index();
                        const isSelected = globalIndex === view.selectedIndex;
                        const marker = match.isDirectory ? '/' : ' ';
                        const selectedBg = isSelected ? { bg: SELECTED_BG } : {};
                        return (
                            <box flexDirection="row">
                                <text {...selectedBg}>
                                    {isSelected ? '> ' : '  '}
                                    {marker}
                                    {match.name}
                                </text>
                            </box>
                        );
                    }}
                </For>
            )}
        </OverlayFrame>
    );
}
