import { TextAttributes } from '@opentui/core';
import type { ApprovalLevel } from '../commands/approval-level.js';

/**
 * Shared selection background for overlays/menus. Supersedes the per-file
 * `SELECTED_BG = '#0000ff'` constants duplicated across OverlayPanels,
 * SlashMenuPanel, and FileAutocompletePanel.
 */
export const SELECTED_BG = '#0000ff';

/**
 * Dark-navy (NON-gray) background for the two status lines that bracket the
 * chat prompt. Deliberately distinct from the prompt's dark-gray `#0a0a0a`
 * band so the status rows read as a header/footer, not the input field.
 */
export const STATUS_LINE_BG = '#0a1020';

/**
 * Approval-level color ramp consumed by the bottom status line. Tuned one
 * saturation step below pure RGB (~70% chroma) so the indicator reads as a
 * calm ramp rather than neon. `verbose` is gray (no saturation).
 */
export const APPROVAL_LEVEL_COLORS: Record<ApprovalLevel, string> = {
    verbose: '#888888',
    safe: '#26d926',
    aggressive: '#d9d926',
    reckless: '#d98526',
    yolo: '#d92626',
};

/**
 * The three overlay shapes `<OverlayFrame>` (todo T2) renders. The modal is a
 * focused, attention-grabbing dialog; panel and view are less prominent
 * containers that share the same chrome minus the inverse header.
 */
export type OverlayVariant = 'modal' | 'panel' | 'view';

/**
 * Named accent colors keyed by overlay purpose so callers select by intent
 * rather than hard-coding hex. `default` is the fallback header color.
 */
export const ACCENTS = {
    default: '#00ffff',
    approval: '#ffff00',
    question: '#ff00ff',
    error: '#ff0000',
} as const;

export type AccentKey = keyof typeof ACCENTS;

/** Static chrome flags resolved per variant; header fields are derived after. */
type OverlayChromeFlags = {
    readonly inverse: boolean;
    readonly separator: boolean;
    readonly bold: boolean;
};

/** Full chrome contract consumed by `<OverlayFrame>`. */
export type OverlayChrome = OverlayChromeFlags & {
    readonly headerFg: string;
    readonly headerAttrs: number;
};

function flagsForVariant(variant: OverlayVariant): OverlayChromeFlags {
    switch (variant) {
        case 'modal':
            return { inverse: true, separator: false, bold: true };
        case 'panel':
            return { inverse: false, separator: false, bold: true };
        case 'view':
            return { inverse: false, separator: false, bold: true };
        default: {
            // Exhaustive: a newly added OverlayVariant becomes a compile error here.
            const exhaustive: never = variant;
            throw new Error(`Unhandled overlay variant: ${String(exhaustive)}`);
        }
    }
}

/**
 * Resolve the full chrome for an overlay variant. `accent` overrides the
 * default header foreground; when omitted the default accent is used.
 * `headerAttrs` starts at BOLD and gains INVERSE only for inverse variants.
 */
export function resolveOverlayChrome(variant: OverlayVariant, accent?: string): OverlayChrome {
    const flags = flagsForVariant(variant);
    const headerFg = accent ?? ACCENTS.default;
    const headerAttrs = flags.inverse ? TextAttributes.BOLD | TextAttributes.INVERSE : TextAttributes.BOLD;
    return { ...flags, headerFg, headerAttrs };
}
