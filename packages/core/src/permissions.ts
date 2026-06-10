import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';

export function createDefaultPermissionDecision(request: PermissionRequest): PermissionDecision {
    return {
        requestId: request.id,
        status: 'deny',
        reason: 'default JSON permission decision',
    };
}

export function createAllowPermissionDecision(request: PermissionRequest): PermissionDecision {
    return {
        requestId: request.id,
        status: 'allow',
        reason: 'scaffold permission allow',
    };
}
