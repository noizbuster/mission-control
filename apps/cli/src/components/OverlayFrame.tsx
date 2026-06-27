/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import type { OverlayVariant } from './overlay-theme.js';
import { resolveOverlayChrome } from './overlay-theme.js';
import { Separator } from './Separator.js';

export type OverlayFrameProps = {
    readonly variant: OverlayVariant;
    readonly title: string;
    readonly accent?: string;
    readonly hint?: string;
    readonly footer?: string;
    readonly separatorState?: 'awaiting_input' | 'running' | 'idle';
    readonly children: React.ReactNode;
};

/**
 * Shared presentational frame for every overlay, modal, panel, and view in the
 * CLI chat TUI. Resolves chrome (header color/attributes, separator, body
 * padding) from the variant via {@link resolveOverlayChrome} and renders the
 * caller-supplied children inside.
 *
 * PURELY PRESENTATIONAL: this component owns no keyboard input, no
 * overlay-mode/transcript placement, and no store reads. Callers (ChatApp's
 * overlay-mode switch and the per-overlay panels) own those concerns; this
 * frame only renders the chrome and the children they hand it.
 */
export function OverlayFrame({
    variant,
    title,
    accent,
    hint,
    footer,
    separatorState,
    children,
}: OverlayFrameProps): React.ReactNode {
    const chrome = resolveOverlayChrome(variant, accent);

    // The modal reproduces the pre-refactor layout: a top Separator, then a padded
    // body box whose first child is the INVERSE title and whose last child is the
    // DIM footer hint. (Note: opentui merges adjacent <text> siblings onto one row,
    // so in overlays whose body starts with a bare <text> the title visually merges
    // with it — this is the pre-existing original behavior, intentionally preserved,
    // not a bug introduced by this frame.)
    if (variant === 'modal') {
        return (
            <box flexDirection="column">
                {chrome.separator ? <Separator state={separatorState ?? 'awaiting_input'} /> : null}
                <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                    <text fg={chrome.headerFg} attributes={chrome.headerAttrs}>{` ${title} `}</text>
                    {children}
                    {footer ? <text attributes={TextAttributes.DIM}>{footer}</text> : null}
                </box>
            </box>
        );
    }

    return (
        <box flexDirection="column">
            {variant === 'view' ? (
                <box flexDirection="row" marginTop={1} paddingLeft={1} paddingRight={1}>
                    <text fg={chrome.headerFg} attributes={TextAttributes.BOLD}>{` ${title} `}</text>
                    {hint ? <text attributes={TextAttributes.DIM}>{` ${hint}`}</text> : null}
                </box>
            ) : (
                <text fg={chrome.headerFg} attributes={chrome.headerAttrs}>{` ${title} `}</text>
            )}
            {children}
            {footer ? <text attributes={TextAttributes.DIM}>{footer}</text> : null}
        </box>
    );
}
