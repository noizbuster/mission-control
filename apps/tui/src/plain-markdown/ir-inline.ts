import type { Token } from 'marked';
import type { InlineRun } from './ir-types';
import { linkFallbackSuffix, textRun } from './ir-types';
import type { TerminalMarkdownTheme, TerminalTextStyle } from './theme';

function flattenRunsText(runs: readonly InlineRun[]): string {
    return runs.map((run) => run.text).join('');
}

function tokenFallbackText(token: Token): string {
    if ('text' in token && typeof token.text === 'string') return token.text;
    return token.raw;
}

export function renderInlineToRuns(
    tokens: readonly Token[],
    theme: TerminalMarkdownTheme,
    baseStyle: TerminalTextStyle,
): readonly InlineRun[] {
    const runs: InlineRun[] = [];
    for (const token of tokens) {
        switch (token.type) {
            case 'text':
                runs.push(
                    ...(token.tokens?.length
                        ? renderInlineToRuns(token.tokens, theme, baseStyle)
                        : [textRun(token.text, baseStyle)]),
                );
                break;
            case 'paragraph':
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, baseStyle));
                break;
            case 'strong':
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, { ...baseStyle, ...theme.bold }));
                break;
            case 'em':
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, { ...baseStyle, ...theme.italic }));
                break;
            case 'codespan':
                runs.push(textRun(token.text, { ...baseStyle, ...theme.code }));
                break;
            case 'del':
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, { ...baseStyle, ...theme.strikethrough }));
                break;
            case 'link': {
                const links = renderInlineToRuns(token.tokens ?? [], theme, { ...baseStyle, ...theme.link }).map(
                    (run) => ({
                        text: run.text,
                        style: run.style,
                        href: token.href,
                    }),
                );
                runs.push(...links);
                const suffix = linkFallbackSuffix(token.href, flattenRunsText(links));
                if (suffix !== '') runs.push(textRun(suffix, { ...baseStyle, ...theme.linkUrl }));
                break;
            }
            case 'br':
                runs.push(textRun('\n', baseStyle));
                break;
            case 'html':
                runs.push(textRun(token.raw, baseStyle));
                break;
            default:
                runs.push(textRun(tokenFallbackText(token), baseStyle));
        }
    }
    return runs;
}
