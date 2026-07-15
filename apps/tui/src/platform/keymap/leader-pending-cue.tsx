/** @jsxImportSource @opentui/solid */
/**
 * Minimal pending-sequence cue (T7).
 *
 * Renders a small dim indicator while a multi-key sequence (typically a leader
 * combo such as `ctrl+x` then `m`) is in progress, so the user sees that the
 * next key continues the sequence rather than typing into the textarea. It
 * renders `null` when no sequence is pending, so it contributes nothing to the
 * layout outside of an active chord.
 *
 * Mounted inside `ChatKeymapProvider` (above ChatRoot) so it always has a
 * keymap in context and never contends with the chat store's own state.
 *
 * It reads the pending sequence reactively via Solid `useKeymapSelector`, so the
 * cue tracks the leader lifecycle without a custom reactive bridge.
 *
 * Visual scope is deliberately minimal (T7 = "register addons + a cue"); T8
 * command-palette / T9 which-key / T14 diff-viewer own richer overlay layout
 * and absolute positioning later.
 */
import { useKeymapSelector } from '@opentui/keymap/solid';
import { createMemo, type JSX, Show } from 'solid-js';
import type { OpenTuiKeymap } from './keymap-instance';

export function LeaderPendingCue(): JSX.Element {
    const sequence = useKeymapSelector((keymap: OpenTuiKeymap) => keymap.getPendingSequence());
    const label = createMemo(() =>
        sequence()
            .map((part) => part.display)
            .join(' '),
    );
    const fg = '#808080';
    const attributes = { dim: true };
    return (
        <Show when={sequence().length > 0}>
            <box position="absolute" top={0} right={2} paddingLeft={1} paddingRight={1}>
                <text fg={fg} {...attributes}>{`${label()} \u2026`}</text>
            </box>
        </Show>
    );
}
