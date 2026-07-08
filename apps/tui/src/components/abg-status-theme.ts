import type { AbgGraphStatus, AbgNodeStatus } from '@mission-control/protocol';

/**
 * Foreground for low-signal statuses (created, cancelled, no-status-yet).
 * Exported so list views can dim low-signal graph rows by comparing against it,
 * and so a future DESIGN.md retune (T1) can swap the gray ramp in one place
 * without re-deriving the value at each call site.
 */
export const STATUS_FG_GRAY = '#808080';

const STATUS_FG_YELLOW = '#ffff00';
const STATUS_FG_GREEN = '#00ff00';
const STATUS_FG_RED = '#ff0000';
const STATUS_FG_CYAN = '#00ffff';

/**
 * Glyph + color theme for a single ABG graph or node status.
 *
 * `foreground` is optional: idle and starting nodes carry no foreground so the
 * caller renders them with its own dim/default style, preserving the
 * pre-centralization visible output. `background` and `pulseStyle` are reserved
 * for DESIGN.md-driven additions; no current caller reads them.
 */
export interface StatusTheme {
    readonly glyph: string;
    readonly foreground?: string;
    readonly background?: string;
    readonly pulseStyle?: string;
}

/**
 * Resolve the glyph + foreground for an ABG node status. Exhaustive over the
 * protocol union: adding a node status is a compile error here, which is the
 * guarantee the table-driven test pins against.
 */
export function nodeStatusTheme(status: AbgNodeStatus): StatusTheme {
    switch (status) {
        case 'idle':
            return { glyph: '∙' };
        case 'starting':
            return { glyph: '○' };
        case 'running':
            return { glyph: '▶', foreground: STATUS_FG_YELLOW };
        case 'succeeded':
            return { glyph: '✓', foreground: STATUS_FG_GREEN };
        case 'failed':
            return { glyph: '✗', foreground: STATUS_FG_RED };
        case 'blocked':
            return { glyph: '⏸', foreground: STATUS_FG_CYAN };
        case 'cancelled':
            return { glyph: '⊘', foreground: STATUS_FG_GRAY };
        default: {
            // Exhaustive: a newly added AbgNodeStatus becomes a compile error.
            const exhaustive: never = status;
            throw new Error(`Unhandled ABG node status: ${String(exhaustive)}`);
        }
    }
}

/**
 * Resolve the glyph + foreground for an ABG graph status. Every graph status
 * carries an explicit foreground (created and cancelled share the gray ramp).
 * Exhaustive over the protocol union like {@link nodeStatusTheme}.
 */
export function graphStatusTheme(status: AbgGraphStatus): StatusTheme {
    switch (status) {
        case 'created':
            return { glyph: '○', foreground: STATUS_FG_GRAY };
        case 'active':
            return { glyph: '▶', foreground: STATUS_FG_YELLOW };
        case 'blocked':
            return { glyph: '⏸', foreground: STATUS_FG_CYAN };
        case 'completed':
            return { glyph: '✓', foreground: STATUS_FG_GREEN };
        case 'failed':
            return { glyph: '✗', foreground: STATUS_FG_RED };
        case 'cancelled':
            return { glyph: '⊘', foreground: STATUS_FG_GRAY };
        default: {
            // Exhaustive: a newly added AbgGraphStatus becomes a compile error.
            const exhaustive: never = status;
            throw new Error(`Unhandled ABG graph status: ${String(exhaustive)}`);
        }
    }
}
