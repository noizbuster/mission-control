/** @jsxImportSource @opentui/react */
import type { ApprovalLevel } from '../commands/approval-level.js';
import { basename } from 'node:path';

export type StatusBarProps = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
    readonly sessionDisplayName?: string;
    readonly workspaceRoot?: string;
    readonly gitBranch?: string;
    readonly approvalLevel?: ApprovalLevel;
};

export function formatStatus(props: StatusBarProps): string {
    const parts = [`provider: ${props.providerID}`, `model: ${props.modelID}`];
    if (props.variantID !== undefined) {
        parts.push(`variant: ${props.variantID}`);
    }
    if (props.approvalLevel !== undefined) {
        parts.push(`approval: ${props.approvalLevel}`);
    }
    if (props.workspaceRoot !== undefined) {
        const dirLabel = basename(props.workspaceRoot) || props.workspaceRoot;
        if (props.gitBranch !== undefined && props.gitBranch.length > 0) {
            parts.push(`project: ${dirLabel} (${props.gitBranch})`);
        } else {
            parts.push(`project: ${dirLabel}`);
        }
    } else if (props.gitBranch !== undefined && props.gitBranch.length > 0) {
        parts.push(`branch: ${props.gitBranch}`);
    }
    if (props.sessionDisplayName !== undefined) {
        if (props.sessionID !== undefined) {
            parts.push(`session: ${props.sessionDisplayName} (${props.sessionID})`);
        } else {
            parts.push(`session: ${props.sessionDisplayName}`);
        }
    } else if (props.sessionID !== undefined) {
        parts.push(`session: ${props.sessionID}`);
    }
    return parts.join(' | ');
}

export function StatusBar(props: StatusBarProps): React.ReactNode {
    return <text {...{ dim: true }}>{formatStatus(props)}</text>;
}
