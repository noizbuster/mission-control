/** @jsxImportSource @opentui/solid */
import type { JSX } from 'solid-js';

export type ToastProps = {
    readonly message: string;
};

/**
 * Transient toast notification. Floats at the bottom-right of the transcript
 * region, i.e. immediately above the TopStatusBar (the status bar above the
 * prompt). Owned by ChatApp local state (presentational only — does not flow
 * through ChatStore). Rendered as the last child of the transcript container so
 * it lands on top.
 */
export function Toast({ message }: ToastProps): JSX.Element {
    return (
        <box position="absolute" bottom={0} right={0} paddingLeft={1} paddingRight={1} backgroundColor="#1a1a2e">
            <text fg="#e4e4ef">{message}</text>
        </box>
    );
}
