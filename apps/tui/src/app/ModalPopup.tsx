/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';

export function ModalPopup({ children }: { readonly children: JSX.Element }): JSX.Element {
    return (
        <box
            position="absolute"
            top={1}
            left={2}
            right={2}
            backgroundColor="#0a0a0a"
            borderStyle="single"
            borderColor="#808080"
        >
            {children}
        </box>
    );
}
