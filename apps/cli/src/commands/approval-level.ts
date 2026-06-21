import type { PermissionRule } from '@mission-control/protocol';

export type ApprovalLevel = 'verbose' | 'safe' | 'aggressive' | 'reckless' | 'yolo';

export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ['verbose', 'safe', 'aggressive', 'reckless', 'yolo'];

export type ApprovalLevelMeta = {
    readonly description: string;
    readonly rules: readonly PermissionRule[];
};

export const APPROVAL_LEVEL_META: Record<ApprovalLevel, ApprovalLevelMeta> = {
    verbose: {
        description: 'Ask for every tool call, including reads',
        rules: [
            { permission: 'read', pattern: '*', decision: 'ask' },
            { permission: 'edit', pattern: '*', decision: 'ask' },
            { permission: 'write', pattern: '*', decision: 'ask' },
            { permission: 'patch', pattern: '*', decision: 'ask' },
            { permission: 'bash', pattern: '*', decision: 'ask' },
            { permission: 'network', pattern: '*', decision: 'ask' },
            { permission: 'subagent', pattern: '*', decision: 'ask' },
        ],
    },
    safe: {
        description: 'Auto-approve read-only tools; ask before modifications',
        rules: [
            { permission: 'read', pattern: '*', decision: 'always' },
            { permission: 'edit', pattern: '*', decision: 'ask' },
            { permission: 'write', pattern: '*', decision: 'ask' },
            { permission: 'patch', pattern: '*', decision: 'ask' },
            { permission: 'bash', pattern: '*', decision: 'ask' },
            { permission: 'network', pattern: '*', decision: 'ask' },
            { permission: 'subagent', pattern: '*', decision: 'ask' },
        ],
    },
    aggressive: {
        description: 'Auto-approve reads and file edits; ask before bash/network',
        rules: [
            { permission: 'read', pattern: '*', decision: 'always' },
            { permission: 'edit', pattern: '*', decision: 'always' },
            { permission: 'write', pattern: '*', decision: 'always' },
            { permission: 'patch', pattern: '*', decision: 'always' },
            { permission: 'bash', pattern: '*', decision: 'ask' },
            { permission: 'network', pattern: '*', decision: 'ask' },
            { permission: 'subagent', pattern: '*', decision: 'ask' },
        ],
    },
    reckless: {
        description: 'Auto-approve everything except network and system-dangerous ops',
        rules: [
            { permission: 'read', pattern: '*', decision: 'always' },
            { permission: 'edit', pattern: '*', decision: 'always' },
            { permission: 'write', pattern: '*', decision: 'always' },
            { permission: 'patch', pattern: '*', decision: 'always' },
            { permission: 'bash', pattern: '*', decision: 'always' },
            { permission: 'network', pattern: '*', decision: 'ask' },
            { permission: 'subagent', pattern: '*', decision: 'always' },
        ],
    },
    yolo: {
        description: 'Auto-approve everything including network (use with caution)',
        rules: [
            { permission: 'read', pattern: '*', decision: 'always' },
            { permission: 'edit', pattern: '*', decision: 'always' },
            { permission: 'write', pattern: '*', decision: 'always' },
            { permission: 'patch', pattern: '*', decision: 'always' },
            { permission: 'bash', pattern: '*', decision: 'always' },
            { permission: 'network', pattern: '*', decision: 'always' },
            { permission: 'subagent', pattern: '*', decision: 'always' },
        ],
    },
};

export function approvalLevelRules(level: ApprovalLevel): readonly PermissionRule[] {
    return APPROVAL_LEVEL_META[level].rules;
}

export function isApprovalLevel(value: string): value is ApprovalLevel {
    return (APPROVAL_LEVELS as readonly string[]).includes(value);
}
