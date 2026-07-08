import { type BorderCharacters, TextAttributes } from '@opentui/core';
import type { ApprovalLevel } from '../state/approval-level.js';

/**
 * Shared selection background for overlays/menus. Supersedes the per-file
 * `SELECTED_BG = '#0000ff'` constants duplicated across OverlayPanels,
 * SlashMenuPanel, and FileAutocompletePanel.
 */
export const SELECTED_BG = '#0000ff';

/**
 * Panel background for the inline (in-place) overlays that replace the input
 * area, e.g. the ask-user QuestionOverlay. Matches {@link ModalPopup}'s popup
 * fill so the inline panel and the floating modals share one dark base.
 */
export const OVERLAY_PANEL_BG = '#0a0a0a';

/**
 * Foreground used for the label of the currently cursor/hovered choice. Pure
 * white reads at maximum contrast against {@link SELECTED_BG}; before this the
 * selected row only swapped its background and left the label fg unchanged, so
 * the text itself was not emphasized (the reported "can't tell which is
 * selected" symptom).
 */
export const QUESTION_SELECTED_FG = '#ffffff';

/**
 * Foreground of the cursor chevron painted next to the active choice. Yellow
 * pops against the blue selection band and the dark panel bg.
 */
export const QUESTION_CURSOR_FG = '#ffff00';

/**
 * The heavy chevron prefix that marks the active (keyboard- or hover-selected)
 * choice row. Mirrors oh-my-pi's `nav.cursor` glyph.
 */
export const QUESTION_CURSOR = '\u276f';

/**
 * opencode-style left-only accent border: every border cell is blank except
 * the vertical, which is a heavy bar `┃` drawn in the overlay's accent color.
 * Used with `<box border={["left"]} customBorderChars={LEFT_ACCENT_BORDER}
 * borderColor={accent}>` to give an inline panel the signature single-stripe
 * frame without a full box border.
 */
export const LEFT_ACCENT_BORDER: BorderCharacters = {
    topLeft: '',
    topRight: '',
    bottomLeft: '',
    bottomRight: '',
    horizontal: '',
    vertical: '\u2503',
    topT: '',
    bottomT: '',
    leftT: '',
    rightT: '',
    cross: '',
};

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
 *
 * `headerAttrs` is plain BOLD for every variant. The `inverse` flag on the
 * modal still marks its intent (a colour-swapped header), but the swap is
 * realised in `<OverlayFrame>` via explicit `fg`/`bg` rather than SGR INVERSE:
 * opentui's `<text>` with `fg` set and no `bg` plus `INVERSE` paints both the
 * foreground and the background with the accent, hiding the title (e.g. the
 * yellow "Approval Required" header on a yellow cell).
 */
export function resolveOverlayChrome(variant: OverlayVariant, accent?: string): OverlayChrome {
    const flags = flagsForVariant(variant);
    const headerFg = accent ?? ACCENTS.default;
    const headerAttrs = TextAttributes.BOLD;
    return { ...flags, headerFg, headerAttrs };
}
