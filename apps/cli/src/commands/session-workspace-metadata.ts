import { ProjectTrustStore } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';

export type SessionWorkspaceMetadata = {
    readonly cwd: string;
    readonly trustedRoot: string;
    readonly workspaceTrust: 'trusted' | 'denied' | 'unknown';
};

export async function resolveSessionWorkspaceMetadata(workspaceRoot: string): Promise<SessionWorkspaceMetadata> {
    const trust = await new ProjectTrustStore().getDecision(workspaceRoot);
    return {
        cwd: trust.workspaceRoot,
        trustedRoot: trust.workspaceRoot,
        workspaceTrust: trust.decision,
    };
}

export function createSessionWorkspaceMetadataEvent(sessionId: string, metadata: SessionWorkspaceMetadata): AgentEvent {
    return {
        type: 'session.metadata.updated',
        timestamp: new Date().toISOString(),
        sessionId,
        message: 'session metadata updated',
        nativeSidecarStatus: 'mock',
        sessionTree: {
            kind: 'metadata',
            cwd: metadata.cwd,
            trustedRoot: metadata.trustedRoot,
            workspaceTrust: metadata.workspaceTrust,
        },
    };
}
