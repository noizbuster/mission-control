/**
 * Shared workspace-trust check for the CLI surface. Several call sites only need the boolean
 * "is this workspace trusted?" answer; each previously opened its own `ProjectTrustStore` and
 * compared `.decision === 'trusted'`. Centralizing it keeps the trust-read contract in one place
 * (the full `ProjectTrustLookup` — needed for the normalized workspace root — stays available
 * via `new ProjectTrustStore().getDecision(root)` at the callers that consume more than the
 * boolean).
 */
import { ProjectTrustStore } from '@mission-control/core';

export async function isWorkspaceTrusted(workspaceRoot: string): Promise<boolean> {
    const trust = await new ProjectTrustStore().getDecision(workspaceRoot);
    return trust.decision === 'trusted';
}
