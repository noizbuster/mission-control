import { resolveProjectTrustDecision } from '../trust/project-trust-store.js';
import type { ResolvedBrowserToolOptions } from './browser-tool-contract.js';
import { ToolExecutionError } from './tool-registry-types.js';

type BrowserLiveAuthority = Pick<ResolvedBrowserToolOptions, 'projectTrustStore' | 'workspaceRoot'>;

export async function requireBrowserLiveAuthority(
    authority: BrowserLiveAuthority,
    resetBrowserState: () => Promise<void>,
): Promise<void> {
    const decision = await resolveProjectTrustDecision(authority.workspaceRoot, authority.projectTrustStore);
    if (decision === 'trusted') return;
    await resetBrowserState();
    throw new ToolExecutionError({
        code: 'tool_failed',
        message: 'workspace_untrusted: browser authority was revoked',
        retryable: false,
    });
}
