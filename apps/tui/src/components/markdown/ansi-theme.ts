/**
 * ANSI SGR escape constants and the single bridge that maps the repo's
 * `TerminalMarkdownTheme` element styles to ANSI open sequences.
 *
 * The SGR constants mirror opencode's `UI.Style` (see
 * `temp/ref-repos/opencode/.../terminal/ui.ts`). The theme type flowing through the
 * whole block pipeline is the REPO's existing `TerminalMarkdownTheme`
 * (`./theme.ts`); this module introduces NO new
 * theme type. The one exported bridge is `terminalTextStyleToAnsi`.
 *
 * SGR reference:
 *   0 reset, 1 bold, 2 dim, 3 italic, 4 underline, 7 inverse, 9 strikethrough.
 *   Foreground truecolor: `38;2;R;G;B`. Background truecolor: `48;2;R;G;B`.
 */

export {
    RESET,
    sgr,
    TEXT_DANGER,
    TEXT_DANGER_BOLD,
    TEXT_DIM,
    TEXT_DIM_BOLD,
    TEXT_HIGHLIGHT,
    TEXT_HIGHLIGHT_BOLD,
    TEXT_INFO,
    TEXT_INFO_BOLD,
    TEXT_NORMAL,
    TEXT_NORMAL_BOLD,
    TEXT_SUCCESS,
    TEXT_SUCCESS_BOLD,
    TEXT_WARNING,
    TEXT_WARNING_BOLD,
    terminalTextStyleToAnsi,
    wrap,
} from '../../plain-markdown/ansi.js';

// --- SGR escape constants (mirror opencode UI.Style) ------------------------
