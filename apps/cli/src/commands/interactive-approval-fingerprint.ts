import type { PermissionRequest } from '@mission-control/protocol';

export function permissionRequestFingerprint(request: PermissionRequest): string {
    const permission = request.permission;
    return JSON.stringify({
        id: request.id,
        action: request.action,
        reason: request.reason,
        permission:
            permission === undefined
                ? null
                : {
                      kind: permission.kind,
                      patterns: permission.patterns,
                      workspaceRoot: permission.workspaceRoot ?? null,
                  },
    });
}
