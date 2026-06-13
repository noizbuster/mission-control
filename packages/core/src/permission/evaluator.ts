import type { PermissionDecision, PermissionRequest, PermissionRule } from '@mission-control/protocol';
import { matchesGlob } from './glob.js';

export type PermissionEvaluation = {
    readonly decision: PermissionDecision;
    readonly consumeOnceRules: readonly PermissionRule[];
};

type MatchingRule = {
    readonly rule: PermissionRule;
    readonly index: number;
};

export function evaluatePermissionRequest(
    request: PermissionRequest,
    rules: readonly PermissionRule[],
    defaultReason: string,
): PermissionEvaluation {
    const scope = request.permission;
    if (scope === undefined) {
        return {
            decision: {
                requestId: request.id,
                status: 'requires_approval',
                reason: defaultReason,
            },
            consumeOnceRules: [],
        };
    }

    const matches = scope.patterns.map((pattern) => findMatchingRule(scope.kind, pattern, scope.workspaceRoot, rules));
    const denyMatch = matches.find((match) => match?.rule.decision === 'deny');
    if (denyMatch !== undefined) {
        return {
            decision: {
                requestId: request.id,
                status: 'deny',
                reason: request.reason,
                matchedRule: denyMatch.rule,
            },
            consumeOnceRules: [],
        };
    }

    const requiresApproval = matches.some((match) => match === undefined || match.rule.decision === 'ask');
    if (requiresApproval) {
        return {
            decision: {
                requestId: request.id,
                status: 'requires_approval',
                reason: request.reason,
            },
            consumeOnceRules: [],
        };
    }

    const allowingMatches = matches.filter((match): match is MatchingRule => match !== undefined);
    const onceRules = allowingMatches.map((match) => match.rule).filter((rule) => rule.decision === 'once');
    return {
        decision: {
            requestId: request.id,
            status: 'allow',
            reason: request.reason,
            matchedRule: allowingMatches.at(-1)?.rule,
        },
        consumeOnceRules: onceRules,
    };
}

function findMatchingRule(
    permission: PermissionRule['permission'],
    pattern: string,
    workspaceRoot: string | undefined,
    rules: readonly PermissionRule[],
): MatchingRule | undefined {
    const matches: MatchingRule[] = [];
    rules.forEach((rule, index) => {
        if (rule.permission !== permission) {
            return;
        }
        if (rule.workspaceRoot !== undefined && rule.workspaceRoot !== workspaceRoot) {
            return;
        }
        if (!matchesGlob(pattern, rule.pattern)) {
            return;
        }
        matches.push({ rule, index });
    });
    return matches.at(-1);
}
