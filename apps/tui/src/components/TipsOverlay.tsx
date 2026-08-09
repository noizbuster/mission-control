/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import type { JSX } from 'solid-js';
import { OverlayFrame } from './OverlayFrame';

const TIPS: readonly { readonly chord: string; readonly label: string }[] = [
    { chord: 'ctrl+c', label: 'Interrupt turn / clear draft / exit' },
    { chord: 'ctrl+p', label: 'Cycle model' },
    { chord: 'alt+x', label: 'Command palette' },
    { chord: 'ctrl+g', label: 'ABG overlay' },
    { chord: '<leader>g', label: 'ABG minimap' },
    { chord: '<leader>d', label: 'Diagnostics panel' },
    { chord: '<leader>h', label: 'Tips panel' },
    { chord: '<leader>u / <leader>r', label: 'Undo / redo last exchange (view only)' },
    { chord: '<leader>s / <leader>p', label: 'Stash / pop prompt draft' },
    { chord: 'ctrl+o', label: 'Expand tool output' },
    { chord: 'pgup / pgdn', label: 'Scroll transcript' },
    { chord: '/compact', label: 'Compact session context' },
    { chord: '/undo / /redo', label: 'CLI undo/redo (typed-aware in TUI)' },
];

/**
 * Lightweight operator tips panel. Catalog-backed keybind names stay in
 * keybind.ts; this overlay is the runtime home for `tips_toggle` (`<leader>h`).
 */
export function TipsOverlay(): JSX.Element {
    return (
        <OverlayFrame variant="view" title="Tips" hint="(Esc or leader+h to close)" footer="Common chords · view only">
            <box flexDirection="column" marginTop={1}>
                {TIPS.map((tip) => (
                    <box flexDirection="row">
                        <text attributes={TextAttributes.BOLD}>{tip.chord}</text>
                        <text attributes={TextAttributes.DIM}>{`  ${tip.label}`}</text>
                    </box>
                ))}
            </box>
        </OverlayFrame>
    );
}
