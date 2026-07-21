import type { PermissionKind, PolicyEffectRule, ProtocolError } from '@mission-control/protocol';
import { evaluateRules } from '../permissions/rule-evaluator';
import { wildcardMatch } from '../permissions/wildcard-match';
import type { ToolAdvertisement, ToolInvocationPolicy } from '../tools/tool-registry';
import { childPolicyResourceValue, resourcesForChildInvocation } from './child-tool-resources';

export type ChildToolRuleGroups = readonly (readonly PolicyEffectRule[])[];

export function isToolDeniedForEveryResource(
    advertisement: ToolAdvertisement,
    ruleGroups: ChildToolRuleGroups,
): boolean {
    return policyActionsFor(advertisement).some((action) =>
        ruleGroups.some((rules) => isActionDeniedForEveryResource(action, rules)),
    );
}

export function createChildToolInvocationPolicy(
    ruleGroups: ChildToolRuleGroups,
    workspaceRoot: string,
): ToolInvocationPolicy {
    return (advertisement, parsedArguments) => {
        for (const action of policyActionsFor(advertisement)) {
            const resolution = resourcesForChildInvocation(advertisement.name, parsedArguments);
            if (resolution.kind === 'malformed') return undefined;
            for (const rules of ruleGroups) {
                if (resolution.kind === 'unsupported') {
                    if (hasScopedDeny(action, rules)) {
                        return deniedError(advertisement.name, action);
                    }
                    continue;
                }
                if (
                    resolution.resources.some(
                        (resource) =>
                            evaluateRules(action, childPolicyResourceValue(resource, workspaceRoot), [
                                { rules: [...rules] },
                            ]).effect === 'deny',
                    )
                ) {
                    return deniedError(advertisement.name, action);
                }
            }
        }
        return undefined;
    };
}

const MCP_TOOL_NAME_PREFIX = 'mcp__';

export function isCategoryToolAllowed(toolName: string, categoryTools: readonly string[] | undefined): boolean {
    if (categoryTools === undefined || categoryTools.includes(toolName)) return true;
    if (isNetworkFamilyToolAllowed(toolName, categoryTools)) return true;
    switch (toolName) {
        case 'repo.read':
        case 'repo.read.tagged':
            return categoryTools.includes('read');
        case 'repo.list':
            return categoryTools.includes('ls');
        case 'repo.search':
        case 'ripgrep':
            return categoryTools.includes('grep') || categoryTools.includes('find');
        default:
            return false;
    }
}

function isNetworkFamilyToolAllowed(toolName: string, categoryTools: readonly string[]): boolean {
    if (categoryTools.includes('network')) return isNetworkFamilyToolName(toolName);
    if (toolName === 'webfetch' || toolName === 'web_search') return false;
    if (!toolName.startsWith(MCP_TOOL_NAME_PREFIX)) return false;
    return categoryTools.some(
        (entry) => entry === 'mcp' || entry === 'mcp__*' || entry.startsWith(MCP_TOOL_NAME_PREFIX),
    );
}

function isNetworkFamilyToolName(toolName: string): boolean {
    return toolName === 'webfetch' || toolName === 'web_search' || toolName.startsWith(MCP_TOOL_NAME_PREFIX);
}

function policyActionsFor(advertisement: ToolAdvertisement): readonly string[] {
    const actions: string[] = [];
    for (const capability of [...advertisement.capabilityClasses, advertisement.name]) {
        const permission = permissionKindForCapability(capability);
        if (permission !== undefined && !actions.includes(permission)) actions.push(permission);
        if (!actions.includes(capability)) actions.push(capability);
    }
    return actions;
}

function permissionKindForCapability(capability: string): PermissionKind | undefined {
    switch (capability) {
        case 'read':
        case 'repo.read':
            return 'read';
        case 'edit':
        case 'file.edit':
            return 'edit';
        case 'write':
        case 'file.write':
            return 'write';
        case 'patch':
        case 'file.patch':
            return 'patch';
        case 'bash':
        case 'bash.run':
        case 'command.run':
        case 'exec':
            return 'bash';
        case 'network':
            return 'network';
        case 'subagent':
            return 'subagent';
        default:
            return permissionKindForSuffix(capability);
    }
}

function permissionKindForSuffix(capability: string): PermissionKind | undefined {
    const segments = capability.split('.');
    const suffix = segments[segments.length - 1];
    switch (suffix) {
        case 'read':
        case 'edit':
        case 'write':
        case 'patch':
        case 'bash':
        case 'network':
        case 'subagent':
            return suffix;
        default:
            return undefined;
    }
}

function isActionDeniedForEveryResource(action: string, rules: readonly PolicyEffectRule[]): boolean {
    let broadRuleIndex = -1;
    let broadEffect: PolicyEffectRule['effect'] | undefined;
    for (const [index, rule] of rules.entries()) {
        if (rule.resource === '**' && wildcardMatch(rule.action, action)) {
            broadRuleIndex = index;
            broadEffect = rule.effect;
        }
    }
    if (broadEffect !== 'deny') return false;
    return !rules
        .slice(broadRuleIndex + 1)
        .some((rule) => wildcardMatch(rule.action, action) && rule.effect !== 'deny');
}

function hasScopedDeny(action: string, rules: readonly PolicyEffectRule[]): boolean {
    return rules.some((rule) => wildcardMatch(rule.action, action) && rule.effect === 'deny');
}

function deniedError(toolName: string, action: string): ProtocolError {
    return {
        code: 'tool_failed',
        message: `child permission denied ${action} for ${toolName}`,
        retryable: false,
    };
}
