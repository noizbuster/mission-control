import { noColorTheme, darkTheme as plainDarkTheme } from '../../plain-markdown/theme';
import { highlightCode } from './highlight';
import type { TerminalMarkdownTheme } from './theme';

export const darkTheme: TerminalMarkdownTheme = { ...plainDarkTheme, highlightCode };
export { noColorTheme };
