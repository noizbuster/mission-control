/** @jsxImportSource @opentui/react */
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
 * keymap in context and never contends with the bridge's own state — the plan
 * explicitly forbids wiring this into `opentui-chat-bridge.tsx` (bridge
 * contention; T5/T6/T10-T15/T16 own the bridge).
 *
 * It reads the pending sequence reactively via `usePendingSequence`
 * (`@opentui/keymap/react`), which re-derives `keymap.getPendingSequence()`
 * whenever the keymap's batched `state` signal fires. Pending-sequence changes
 * (leader arm/timeout/escape-clear/backspace-pop) emit `state` (verified
 * empirically — arming fires both `pendingSequence` and `state`), so the cue
 * tracks the leader lifecycle without a custom reactive bridge.
 *
 * Visual scope is deliberately minimal (T7 = "register addons + a cue"); T8
 * command-palette / T9 which-key / T14 diff-viewer own richer overlay layout
 * and absolute positioning later.
 */
import { usePendingSequence } from '@opentui/keymap/react';
import type { ReactNode } from 'react';

export function LeaderPendingCue(): ReactNode {
    const sequence = usePendingSequence();
    if (sequence.length === 0) return null;
    const label = sequence.map((part) => part.display).join(' ');
    // A trailing ellipsis signals "waiting for the next key". Dim gray keeps
    // it unobtrusive (matches StatusBar's dim treatment).
    const fg = '#808080';
    const attributes = { dim: true };
    // Absolute positioning: the cue floats as an overlay so it renders
    // regardless of how the opentui root stacks its flex children (ChatRoot
    // fills the screen with flexGrow, which would squeeze an in-flow sibling
    // to zero height). Out of flow, it never perturbs ChatRoot's layout and
    // contributes nothing while inactive (this branch returns null above).
    return (
        <box position="absolute" top={0} right={2} paddingLeft={1} paddingRight={1}>
            <text {...(fg !== undefined ? { fg } : {})} {...attributes}>{`${label} \u2026`}</text>
        </box>
    );
}
