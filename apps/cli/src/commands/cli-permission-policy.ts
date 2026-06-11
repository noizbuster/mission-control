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

export function createCliPermissionDecision(request: PermissionRequest): PermissionDecision {
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
