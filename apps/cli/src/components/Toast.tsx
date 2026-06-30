/** @jsxImportSource @opentui/react */
import type * as React from 'react';

export type ToastProps = {
    readonly message: string;
};

/**
 * Transient toast notification. Floats at the bottom-right, one row above the
 * BottomStatusBar. Owned by ChatApp local state (presentational only — does not
 * flow through ChatStore). Drawn after the status bars in the JSX so it lands
 * on top of the input band's right edge.
 */
export function Toast({ message }: ToastProps): React.ReactNode {
    return (
        <box position="absolute" bottom={1} right={0} paddingLeft={1} paddingRight={1} backgroundColor="#1a1a2e">
            <text fg="#e4e4ef">{message}</text>
        </box>
    );
}
