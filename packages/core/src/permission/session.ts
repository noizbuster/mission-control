import type { PermissionReply, PermissionRequest, PermissionRule } from '@mission-control/protocol';
import { evaluatePermissionRequest, type PermissionEvaluation } from './evaluator';
import { PermissionRuleStore } from './store';
import { normalizePermissionRequest, normalizePermissionRules } from './workspace-root';

export type PermissionSessionOptions = {
    readonly builtInRules?: readonly PermissionRule[];
    readonly persistedRuleStore?: PermissionRuleStore;
};

export type RememberReplyOptions = {
    readonly tryCommitAuthority?: () => boolean;
};

export class PermissionAuthorityCommitCancelledError extends Error {
    readonly name = 'PermissionAuthorityCommitCancelledError';

    constructor() {
        super('Permission authority commit was cancelled');
    }
}

export class PermissionSession {
    private builtInRules: readonly PermissionRule[];
    private readonly persistedRuleStore: PermissionRuleStore | undefined;
    private readonly sessionRules = new Map<string, PermissionRule[]>();
    private readonly consumedOnceRuleKeys = new Map<string, Set<string>>();

    constructor(options: PermissionSessionOptions = {}) {
        this.builtInRules = options.builtInRules ?? [];
        this.persistedRuleStore = options.persistedRuleStore;
    }

    /**
     * Swap the baseline tier rules at runtime. Session-scoped "always" replies
     * and persisted rules survive; only the level-derived baseline changes.
     */
    replaceBuiltInRules(rules: readonly PermissionRule[]): void {
        this.builtInRules = rules;
    }

    async evaluate(request: PermissionRequest, sessionId: string): Promise<PermissionEvaluation> {
        const normalizedRequest = await normalizePermissionRequest(request);
        const rules = await this.rulesFor(normalizedRequest, sessionId);
        return evaluatePermissionRequest(normalizedRequest, rules, request.reason);
    }

    async rememberReply(
        request: PermissionRequest,
        sessionId: string,
        reply: PermissionReply,
        options: RememberReplyOptions = {},
    ): Promise<void> {
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
        const persistedRuleStore = this.persistedRuleStore;
        if (
            reply.reply === 'always' &&
            reply.persist === true &&
            scope.workspaceRoot !== undefined &&
            persistedRuleStore !== undefined
        ) {
            await persistedRuleStore.appendRules(
                nextRules.map((rule) => ({
                    ...rule,
                    decision: 'always',
                    workspaceRoot: scope.workspaceRoot,
                })),
                { beforeCommit: () => commitAuthority(options) },
            );
        } else {
            commitAuthority(options);
        }
        this.sessionRules.set(sessionId, [...(this.sessionRules.get(sessionId) ?? []), ...nextRules]);
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

function commitAuthority(options: RememberReplyOptions): void {
    if (options.tryCommitAuthority?.() === false) {
        throw new PermissionAuthorityCommitCancelledError();
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
