import { Text } from 'ink';

export type StatusBarProps = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
};

function formatStatus(props: StatusBarProps): string {
    const parts = [`provider: ${props.providerID}`, `model: ${props.modelID}`];
    if (props.variantID !== undefined) {
        parts.push(`variant: ${props.variantID}`);
    }
    if (props.sessionID !== undefined) {
        parts.push(`session: ${props.sessionID}`);
    }
    return parts.join(' | ');
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
    return <Text dimColor>{formatStatus(props)}</Text>;
}
