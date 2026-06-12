import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';

const allowedCliActions = [
    'prompt.submit',
    'task.run',
    'skill.invoke',
    'repo.read',
    'repo.list',
    'repo.search',
] as const;
const approvalRequiredCliActions = ['file.patch', 'command.run'] as const;
export type NonInteractiveAutomationPolicy = 'test-only-allow-known-safe-patch';

export function createCliPermissionDecision(
    request: PermissionRequest,
    automationPolicy?: NonInteractiveAutomationPolicy,
): PermissionDecision {
    if (automationPolicy === 'test-only-allow-known-safe-patch' && request.action === 'file.patch') {
        return {
            requestId: request.id,
            status: 'allow',
            reason: 'test-only automation allows known safe patch',
        };
    }
    if (includesAction(allowedCliActions, request.action)) {
        return {
            requestId: request.id,
            status: 'allow',
            reason: `CLI permission policy allows ${request.action}`,
        };
    }
    if (includesAction(approvalRequiredCliActions, request.action)) {
        return {
            requestId: request.id,
            status: 'requires_approval',
            reason: `CLI approval required for ${request.action}`,
        };
    }
    return {
        requestId: request.id,
        status: 'deny',
        reason: `CLI permission policy denies ${request.action}`,
    };
}

function includesAction(actions: readonly string[], action: string): boolean {
    return actions.includes(action);
}
