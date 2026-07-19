/** @jsxImportSource @opentui/solid */

import { SyntaxStyle } from '@opentui/core';
import { type Accessor, createMemo, type JSX } from 'solid-js';
import { useSolidStoreSelector } from '../../platform/use-solid-store-selector';
import { CHAT_TEXT } from '../chat-theme';
import { getHighlightVersion, subscribeHighlight } from './highlight';
import type { TerminalMarkdownTheme } from './theme';

export * from '../../plain-markdown/ir-blocks';
export * from '../../plain-markdown/ir-inline';
export * from '../../plain-markdown/ir-layout';
export * from '../../plain-markdown/ir-types';

export type MarkdownProps = {
    readonly text: string;
    readonly width?: number;
    readonly streaming?: boolean;
    readonly theme?: TerminalMarkdownTheme;
};

export function useHighlightVersion(): Accessor<number> {
    return useSolidStoreSelector(
        { subscribe: subscribeHighlight, getSnapshot: getHighlightVersion },
        (version) => version,
    );
}

export function markdownSyntaxStyles(theme: TerminalMarkdownTheme | undefined) {
    return {
        default: { fg: theme?.defaultTextStyle?.fg ?? CHAT_TEXT },
        'markdown.bold': { bold: true },
        'markdown.italic': { italic: true },
        'markdown.heading': { bold: true, fg: theme?.heading?.fg ?? '#00ffff' },
        'markdown.link': { underline: true, fg: theme?.link?.fg ?? '#58a6ff' },
        'markdown.code': { fg: theme?.code?.fg ?? '#e0e0e0' },
        'markdown.code.block': { fg: theme?.codeBlock?.fg ?? '#e0e0e0' },
        'markdown.quote': { italic: true, dim: true },
        'markdown.list': { fg: theme?.listBullet?.fg ?? '#ffff00' },
    };
}

export function Markdown(props: MarkdownProps): JSX.Element {
    const syntaxStyle = createMemo(() => {
        const theme = props.theme;
        try {
            return SyntaxStyle.fromStyles(markdownSyntaxStyles(theme));
        } catch {
            return SyntaxStyle.create();
        }
    });
    return (
        <markdown
            content={props.text}
            streaming={props.streaming ?? false}
            syntaxStyle={syntaxStyle()}
            conceal={true}
            width={props.width ?? '100%'}
        />
    );
}
