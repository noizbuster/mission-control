import type { PermissionRequest, PermissionRule } from '@mission-control/protocol';
import { isNodeError } from '../util/node-error';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function normalizePermissionWorkspaceRoot(workspaceRoot: string): Promise<string> {
    const absoluteRoot = resolve(workspaceRoot);
    try {
        return await realpath(absoluteRoot);
    } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
            return absoluteRoot;
        }
        throw error;
    }
}

export async function normalizePermissionRule(rule: PermissionRule): Promise<PermissionRule> {
    if (rule.workspaceRoot === undefined) {
        return rule;
    }
    return {
        ...rule,
        workspaceRoot: await normalizePermissionWorkspaceRoot(rule.workspaceRoot),
    };
}

export async function normalizePermissionRules(rules: readonly PermissionRule[]): Promise<readonly PermissionRule[]> {
    return Promise.all(rules.map((rule) => normalizePermissionRule(rule)));
}

export async function normalizePermissionRequest(request: PermissionRequest): Promise<PermissionRequest> {
    const scope = request.permission;
    if (scope?.workspaceRoot === undefined) {
        return request;
    }
    return {
        ...request,
        permission: {
            ...scope,
            workspaceRoot: await normalizePermissionWorkspaceRoot(scope.workspaceRoot),
        },
    };
}


