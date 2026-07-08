/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import type { OverlayVariant } from './overlay-theme.js';
import { resolveOverlayChrome } from './overlay-theme.js';

export type OverlayFrameProps = {
    readonly variant: OverlayVariant;
    readonly title: string;
    readonly accent?: string;
    readonly hint?: string;
    readonly footer?: string;
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
export function OverlayFrame({ variant, title, accent, hint, footer, children }: OverlayFrameProps): React.ReactNode {
    const chrome = resolveOverlayChrome(variant, accent);

    // Modal renders inside a bordered popup (see ModalPopup in ChatApp), so it
    // has no Separator of its own — the popup border is the delineator. The
    // title and footer each sit in their own <box> row because opentui merges
    // adjacent <text> siblings onto one row: without the wrappers a body that
    // starts (or ends) with a bare <text> visually collides with the title (or
    // footer) — the "Select model Search: …" / "Rename Session Enter new…"
    // jumble seen on ModelPickerOverlay / RenameOverlay / SessionPickerOverlay.
    //
    // The modal title uses explicit fg/bg rather than SGR INVERSE: opentui's
    // `<text>` with `fg` set and no `bg` plus `attributes=INVERSE` paints both
    // the foreground and the background with the accent, hiding the title (the
    // yellow "Approval Required" header was rendering as yellow-on-yellow).
    // Black on the accent keeps contrast for every accent we ship (yellow,
    // cyan, magenta, red are all bright enough to take black text).
    if (variant === 'modal') {
        return (
            <box flexDirection="column">
                <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                    <box height={1}>
                        <text fg="#000000" bg={chrome.headerFg} attributes={TextAttributes.BOLD}>{` ${title} `}</text>
                    </box>
                    {children}
                    {footer ? (
                        <box height={1}>
                            <text attributes={TextAttributes.DIM}>{footer}</text>
                        </box>
                    ) : null}
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
                <box height={1}>
                    <text fg={chrome.headerFg} attributes={chrome.headerAttrs}>{` ${title} `}</text>
                </box>
            )}
            {children}
            {footer ? (
                <box height={1}>
                    <text attributes={TextAttributes.DIM}>{footer}</text>
                </box>
            ) : null}
        </box>
    );
}
