import { PermissionRuleStore, PermissionSession } from '@mission-control/core';
import type { PermissionDecision, PermissionRequest, PermissionRule } from '@mission-control/protocol';

const alwaysAllowedCliActions = ['prompt.submit', 'task.run', 'skill.invoke'] as const;
const permissionScopedCliActions = [
    'repo.read',
    'repo.list',
    'repo.search',
    'file.edit',
    'file.write',
    'file.patch',
    'command.run',
    'bash.run',
] as const;

export type NonInteractiveAutomationPolicy = 'test-only-allow-known-safe-patch';

const knownSafeAutomationPatchPath = '.mctrl-known-safe-automation-patch.txt';
const knownSafeAutomationPatchReason = `apply patch to ${knownSafeAutomationPatchPath}`;

export function cliPermissionRules(): readonly PermissionRule[] {
    return [
        { permission: 'read', pattern: '*', decision: 'always' },
        { permission: 'edit', pattern: '*', decision: 'ask' },
        { permission: 'write', pattern: '*', decision: 'ask' },
        { permission: 'patch', pattern: '*', decision: 'ask' },
        { permission: 'bash', pattern: '*', decision: 'ask' },
    ];
}

export async function createCliPermissionDecision(
    request: PermissionRequest,
    options: {
        readonly automationPolicy?: NonInteractiveAutomationPolicy;
        readonly workspaceRoot?: string;
        readonly session?: PermissionSession;
    } = {},
): Promise<PermissionDecision> {
    if (options.automationPolicy === 'test-only-allow-known-safe-patch' && isKnownSafeAutomationPatchRequest(request)) {
        return {
            requestId: request.id,
            status: 'allow',
            reason: 'test-only automation allows known safe patch',
        };
    }
    if (includesAction(alwaysAllowedCliActions, request.action)) {
        return {
            requestId: request.id,
            status: 'allow',
            reason: `CLI permission policy allows ${request.action}`,
        };
    }
    if (!includesAction(permissionScopedCliActions, request.action)) {
        return {
            requestId: request.id,
            status: 'deny',
            reason: `CLI permission policy denies ${request.action}`,
        };
    }

    const session =
        options.session ??
        new PermissionSession({
            builtInRules: cliPermissionRules(),
            ...(options.workspaceRoot !== undefined ? { persistedRuleStore: new PermissionRuleStore() } : {}),
        });
    const evaluated = await session.evaluate(request, 'cli');
    session.consumeOnceRules('cli', evaluated.consumeOnceRules);
    return normalizeCliDecision(request, evaluated.decision);
}

export function cliAllowsAction(action: string): boolean {
    return includesAction(alwaysAllowedCliActions, action) || includesAction(permissionScopedCliActions, action);
}

function normalizeCliDecision(request: PermissionRequest, decision: PermissionDecision): PermissionDecision {
    switch (decision.status) {
        case 'allow':
            return {
                requestId: request.id,
                status: 'allow',
                reason: decision.reason ?? `CLI permission policy allows ${request.action}`,
                ...(decision.matchedRule !== undefined ? { matchedRule: decision.matchedRule } : {}),
            };
        case 'requires_approval':
            return {
                requestId: request.id,
                status: 'requires_approval',
                reason: `CLI approval required for ${request.action}`,
                ...(decision.matchedRule !== undefined ? { matchedRule: decision.matchedRule } : {}),
            };
        case 'deny':
            return {
                requestId: request.id,
                status: 'deny',
                reason: decision.reason ?? `CLI permission policy denies ${request.action}`,
                ...(decision.matchedRule !== undefined ? { matchedRule: decision.matchedRule } : {}),
            };
    }
}

function includesAction(actions: readonly string[], action: string): boolean {
    return actions.includes(action);
}

function isKnownSafeAutomationPatchRequest(request: PermissionRequest): boolean {
    if (request.action !== 'file.patch' || request.reason !== knownSafeAutomationPatchReason) {
        return false;
    }

    const permission = request.permission;
    return (
        permission?.kind === 'patch' &&
        permission.patterns.length === 1 &&
        permission.patterns[0] === knownSafeAutomationPatchPath
    );
}
