import { type ProjectTrustReader, resolveProjectTrustDecision } from '../../trust/project-trust-store.js';
import { ToolExecutionError } from '../tool-registry-types.js';
import type { McpConfigScope } from './config.js';
import type { McpConnectionManager } from './connection-manager.js';

export async function requireMcpLiveAuthority(
    scope: McpConfigScope,
    workspaceRoot: string,
    connectionManager: McpConnectionManager,
    projectTrustStore: ProjectTrustReader | undefined,
): Promise<void> {
    switch (scope) {
        case 'user':
            return;
        case 'project': {
            const decision =
                projectTrustStore === undefined
                    ? await resolveProjectTrustDecision(workspaceRoot)
                    : await resolveProjectTrustDecision(workspaceRoot, projectTrustStore);
            if (decision === 'trusted') {
                return;
            }
            await connectionManager.disconnectScope('project');
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: 'workspace_untrusted: project MCP authority was revoked',
                retryable: false,
            });
        }
        default:
            return assertNever(scope);
    }
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected MCP config scope: ${String(value)}`);
}
