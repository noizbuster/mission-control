/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { type JSX, Show } from 'solid-js';
import { type TuiToastVariant, useTuiToast } from '../platform/providers/clipboard-toast-context';
import { sanitizeTerminalDisplayText } from '../state/terminal-display-sanitizer';

const TOAST_VARIANT_COLORS: Readonly<Record<TuiToastVariant, string>> = {
    info: '#00ffff',
    success: '#00ff00',
    warning: '#ffff00',
    error: '#ff0000',
};

const TOAST_BACKGROUND = '#1a1a2e';
const TOAST_FOREGROUND = '#e4e4ef';
const TOAST_MAX_COLUMNS = 60;

/**
 * Transient toast notification. Reads from `useTuiToast()` internally — no
 * props. Matches the opencode toast pattern: absolute top-right, variant-
 * colored border, optional bold title, word-wrapped message, responsive width
 * capped at 60 columns. Visibility is controlled by the toast service signal
 * (the service owns the auto-dismiss timer).
 */
export function Toast(): JSX.Element {
    const toast = useTuiToast();
    const dimensions = useTerminalDimensions();

    return (
        <Show when={toast.current()}>
            {(current) => (
                <box
                    position="absolute"
                    top={2}
                    right={2}
                    maxWidth={Math.min(TOAST_MAX_COLUMNS, dimensions().width - 6)}
                    paddingLeft={2}
                    paddingRight={2}
                    paddingTop={1}
                    paddingBottom={1}
                    backgroundColor={TOAST_BACKGROUND}
                    borderColor={TOAST_VARIANT_COLORS[current().variant]}
                    borderStyle="single"
                >
                    <Show when={current().title}>
                        {(title) => (
                            <text attributes={TextAttributes.BOLD} marginBottom={1} fg={TOAST_FOREGROUND}>
                                {sanitizeTerminalDisplayText(title())}
                            </text>
                        )}
                    </Show>
                    <text fg={TOAST_FOREGROUND} wrapMode="word" width="100%">
                        {sanitizeTerminalDisplayText(current().message)}
                    </text>
                </box>
            )}
        </Show>
    );
}
