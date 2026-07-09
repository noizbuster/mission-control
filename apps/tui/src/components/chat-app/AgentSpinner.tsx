/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import { useSpinnerFrame } from '../spinner.js';

export function AgentSpinner({ text }: { readonly text: string }): JSX.Element {
    const { glyph } = useSpinnerFrame();
    return (
        <box marginTop={1} flexShrink={0}>
            <text fg="#00ffff">{`${glyph} ${text}`}</text>
        </box>
    );
}
