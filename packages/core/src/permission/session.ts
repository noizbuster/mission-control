import type { PermissionReply, PermissionRequest, PermissionRule } from '@mission-control/protocol';
import { evaluatePermissionRequest, type PermissionEvaluation } from './evaluator.js';
import { PermissionRuleStore } from './store.js';
import { normalizePermissionRequest, normalizePermissionRules } from './workspace-root.js';

export type PermissionSessionOptions = {
    readonly builtInRules?: readonly PermissionRule[];
    readonly persistedRuleStore?: PermissionRuleStore;
};

export class PermissionSession {
    private readonly builtInRules: readonly PermissionRule[];
    private readonly persistedRuleStore: PermissionRuleStore | undefined;
    private readonly sessionRules = new Map<string, PermissionRule[]>();
    private readonly consumedOnceRuleKeys = new Map<string, Set<string>>();

    constructor(options: PermissionSessionOptions = {}) {
        this.builtInRules = options.builtInRules ?? [];
        this.persistedRuleStore = options.persistedRuleStore;
    }

    async evaluate(request: PermissionRequest, sessionId: string): Promise<PermissionEvaluation> {
        const normalizedRequest = await normalizePermissionRequest(request);
        const rules = await this.rulesFor(normalizedRequest, sessionId);
        return evaluatePermissionRequest(normalizedRequest, rules, request.reason);
    }

    async rememberReply(request: PermissionRequest, sessionId: string, reply: PermissionReply): Promise<void> {
        const normalizedRequest = await normalizePermissionRequest(request);
        const scope = normalizedRequest.permission;
        if (scope === undefined || reply.reply === 'once') {
            return;
        }
        const nextRules = scope.patterns.map<PermissionRule>((pattern) => ({
            permission: scope.kind,
            pattern,
            decision: reply.reply,
            ...(scope.workspaceRoot !== undefined ? { workspaceRoot: scope.workspaceRoot } : {}),
        }));
        this.sessionRules.set(sessionId, [...(this.sessionRules.get(sessionId) ?? []), ...nextRules]);
        if (reply.reply === 'always' && reply.persist === true && scope.workspaceRoot !== undefined) {
            await this.persistedRuleStore?.appendRules(
                nextRules.map((rule) => ({
                    ...rule,
                    decision: 'always',
                    workspaceRoot: scope.workspaceRoot,
                })),
            );
        }
    }

    consumeOnceRules(sessionId: string, rules: readonly PermissionRule[]): void {
        if (rules.length === 0) {
            return;
        }
        const sessionRules = this.sessionRules.get(sessionId) ?? [];
        const remaining = sessionRules.filter((candidate) => !rules.some((rule) => sameRule(rule, candidate)));
        this.sessionRules.set(sessionId, remaining);
        const consumed = this.consumedOnceRuleKeys.get(sessionId) ?? new Set<string>();
        for (const rule of rules) {
            consumed.add(ruleKey(rule));
        }
        this.consumedOnceRuleKeys.set(sessionId, consumed);
    }

    private async rulesFor(request: PermissionRequest, sessionId: string): Promise<readonly PermissionRule[]> {
        const workspaceRoot = request.permission?.workspaceRoot;
        const persisted =
            workspaceRoot === undefined ? [] : await this.persistedRuleStore?.listRules(workspaceRoot).then(toArray);
        const sessionRules = await normalizePermissionRules(this.sessionRules.get(sessionId) ?? []);
        const builtInRules = await normalizePermissionRules(this.builtInRules);
        const consumedKeys = this.consumedOnceRuleKeys.get(sessionId) ?? new Set<string>();
        return [...builtInRules, ...(persisted ?? []), ...sessionRules].filter(
            (rule) => rule.decision !== 'once' || !consumedKeys.has(ruleKey(rule)),
        );
    }
}

function sameRule(left: PermissionRule, right: PermissionRule): boolean {
    return (
        left.permission === right.permission &&
        left.pattern === right.pattern &&
        left.decision === right.decision &&
        left.workspaceRoot === right.workspaceRoot
    );
}

function ruleKey(rule: PermissionRule): string {
    return `${rule.workspaceRoot ?? ''}:${rule.permission}:${rule.pattern}:${rule.decision}`;
}

function toArray<T>(value: readonly T[] | undefined): readonly T[] {
    return value ?? [];
}
