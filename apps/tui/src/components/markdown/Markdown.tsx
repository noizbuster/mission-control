/** @jsxImportSource @opentui/solid */

import type { StyleDefinitionInput } from '@opentui/core';
import { type Accessor, type JSX } from 'solid-js';
import { useSolidStoreSelector } from '../../platform/use-solid-store-selector';
import { CHAT_BG, CHAT_TEXT } from '../chat-theme';
import { getHighlightVersion, subscribeHighlight } from './highlight';
import { getSharedSyntaxStyle } from './shared-syntax-style';
import { buildSyntaxRules } from './syntax-rules';
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

export function markdownSyntaxStyles(theme: TerminalMarkdownTheme | undefined): Record<string, StyleDefinitionInput> {
    const styles: Record<string, StyleDefinitionInput> = {};
    for (const rule of buildSyntaxRules()) {
        const def: StyleDefinitionInput = {};
        if (rule.style.foreground !== undefined) def.fg = rule.style.foreground;
        if (rule.style.background !== undefined) def.bg = rule.style.background;
        if (rule.style.bold === true) def.bold = true;
        if (rule.style.italic === true) def.italic = true;
        if (rule.style.underline === true) def.underline = true;
        if (rule.style.dim === true) def.dim = true;
        for (const scope of rule.scope) {
            styles[scope] = def;
        }
    }
    const defaultFg = theme?.defaultTextStyle?.fg ?? CHAT_TEXT;
    styles['default'] = { ...styles['default'], fg: defaultFg };
    return styles;
}

export function Markdown(props: MarkdownProps): JSX.Element {
    useHighlightVersion();

    const fg = () => props.theme?.defaultTextStyle?.fg ?? CHAT_TEXT;

    return (
        <markdown
            content={props.text}
            streaming={props.streaming ?? false}
            syntaxStyle={getSharedSyntaxStyle()}
            conceal={true}
            internalBlockMode="top-level"
            tableOptions={{ style: 'grid' }}
            fg={fg()}
            bg={CHAT_BG}
            width={props.width ?? '100%'}
        />
    );
}
