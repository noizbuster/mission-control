/** @jsxImportSource @opentui/solid */

import { SyntaxStyle } from '@opentui/core';
import { type Accessor, createMemo, type JSX } from 'solid-js';
import { useSolidStoreSelector } from '../../platform/use-solid-store-selector.js';
import { getHighlightVersion, subscribeHighlight } from './highlight.js';
import type { TerminalMarkdownTheme } from './theme.js';

export * from '../../plain-markdown/ir-blocks.js';
export * from '../../plain-markdown/ir-inline.js';
export * from '../../plain-markdown/ir-layout.js';
export * from '../../plain-markdown/ir-types.js';

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

export function Markdown(props: MarkdownProps): JSX.Element {
    const syntaxStyle = createMemo(() => {
        const theme = props.theme;
        try {
            return SyntaxStyle.fromStyles({
                default: { fg: theme?.heading?.fg ?? '#e0e0e0' },
                'markdown.bold': { bold: true },
                'markdown.italic': { italic: true },
                'markdown.heading': { bold: true, fg: theme?.heading?.fg ?? '#00ffff' },
                'markdown.link': { underline: true, fg: theme?.link?.fg ?? '#58a6ff' },
                'markdown.code': { fg: theme?.code?.fg ?? '#e0e0e0' },
                'markdown.code.block': { fg: theme?.codeBlock?.fg ?? '#e0e0e0' },
                'markdown.quote': { italic: true, dim: true },
                'markdown.list': { fg: theme?.listBullet?.fg ?? '#ffff00' },
            });
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
