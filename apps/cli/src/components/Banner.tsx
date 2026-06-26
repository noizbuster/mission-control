/** @jsxImportSource @opentui/react */
import type { OpenTuiChatBridgeOptions } from '../commands/opentui-chat-bridge.js';
import { toOpenTuiAttributes } from '../platform/opentui-types.js';

// Rendered outside core.outputText so it cannot accumulate as ghost text when
// the scrollback grows past the terminal viewport (root cause of the stacking
// bug). Provider/model/session info mirrors StatusBar props.
export function Banner({ statusBarProps }: { readonly statusBarProps?: OpenTuiChatBridgeOptions }): React.ReactNode {
    if (statusBarProps === undefined) {
        return <text {...toOpenTuiAttributes({ bold: true })}>{'mission-control chat'}</text>;
    }
    const selection = formatSelectionLabel(statusBarProps);
    return (
        <box flexDirection="column">
            <text {...toOpenTuiAttributes({ bold: true })}>{'mission-control chat'}</text>
            <text {...toOpenTuiAttributes({ dimColor: true })}>{selection}</text>
        </box>
    );
}

export function formatSelectionLabel(props: OpenTuiChatBridgeOptions): string {
    const parts = [`provider: ${props.providerID}`, `model: ${props.modelID}`];
    if (props.variantID !== undefined) {
        parts.push(`variant: ${props.variantID}`);
    }
    if (props.sessionID !== undefined) {
        parts.push(`session: ${props.sessionID}`);
    }
    return parts.join(' | ');
}
