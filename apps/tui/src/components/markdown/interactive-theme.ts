import { noColorTheme, darkTheme as plainDarkTheme } from '../../plain-markdown/theme.js';
import { highlightCode } from './highlight.js';
import type { TerminalMarkdownTheme } from './theme.js';

export const darkTheme: TerminalMarkdownTheme = { ...plainDarkTheme, highlightCode };
export { noColorTheme };
