import type { PermissionDecision, PermissionKind, PermissionRequest } from '@mission-control/protocol';
import { PermissionGateError } from '../approval-gate.js';

export function permissionRequest(input: {
    readonly toolCallId: string;
    readonly action: string;
    readonly reason: string;
    readonly permission: PermissionKind;
    readonly patterns: readonly string[];
    readonly workspaceRoot: string;
}): PermissionRequest {
    return {
        id: `permission_${input.toolCallId}`,
        action: input.action,
        reason: input.reason,
        permission: {
            kind: input.permission,
            patterns: [...input.patterns],
            workspaceRoot: input.workspaceRoot,
        },
    };
}

export async function requestToolPermission(
    requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>,
    request: PermissionRequest,
): Promise<PermissionDecision> {
    try {
        return await requestPermission(request);
    } catch (error: unknown) {
        if (!(error instanceof PermissionGateError)) {
            throw error;
        }
        return {
            requestId: request.id,
            status:
                error.code === 'permission_denied' || error.code === 'approval_denied' ? 'deny' : 'requires_approval',
            reason: error.message,
        };
    }
}
