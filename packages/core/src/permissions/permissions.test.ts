import type { PolicyEffectRule, PolicyEffectRuleSet } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { deriveChildPermissions } from './rule-derive.js';
import { type EvaluationResult, evaluateRules } from './rule-evaluator.js';
import { wildcardMatch } from './wildcard-match.js';

describe('wildcardMatch', () => {
    describe('single-segment *', () => {
        it('matches within one path segment', () => {
            expect(wildcardMatch('src/*', 'src/foo.ts')).toBe(true);
        });

        it('does not match a different prefix', () => {
            expect(wildcardMatch('src/*', 'lib/foo.ts')).toBe(false);
        });

        it('does not cross path separators', () => {
            expect(wildcardMatch('src/*', 'src/a/b.ts')).toBe(false);
            expect(wildcardMatch('*', 'a/b')).toBe(false);
        });

        it('matches an action catch-all within a segment', () => {
            expect(wildcardMatch('*', 'edit')).toBe(true);
            expect(wildcardMatch('*', 'bash')).toBe(true);
        });
    });

    describe('recursive **', () => {
        it('matches anything including across separators', () => {
            expect(wildcardMatch('**', 'anything/at/all')).toBe(true);
            expect(wildcardMatch('**', 'single')).toBe(true);
        });

        it('matches nested directories in a path glob', () => {
            expect(wildcardMatch('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
        });

        it('matches zero directories when ** is between segments', () => {
            expect(wildcardMatch('src/**/*.ts', 'src/c.ts')).toBe(true);
        });

        it('matches a trailing recursive glob', () => {
            expect(wildcardMatch('.omo/**', '.omo/plans/work.md')).toBe(true);
            expect(wildcardMatch('.omo/**', '.omo/plans/sub/deep.md')).toBe(true);
        });
    });

    describe('exact and literal matching', () => {
        it('matches identical strings', () => {
            expect(wildcardMatch('edit', 'edit')).toBe(true);
        });

        it('rejects different strings', () => {
            expect(wildcardMatch('edit', 'write')).toBe(false);
        });

        it('escapes regex special characters in the pattern', () => {
            expect(wildcardMatch('a.b', 'a.b')).toBe(true);
            expect(wildcardMatch('a.b', 'axb')).toBe(false);
        });
    });
});

describe('evaluateRules', () => {
    describe('acceptance example', () => {
        it('returns deny for the plan acceptance scenario', () => {
            const rulesets: PolicyEffectRuleSet[] = [
                {
                    rules: [
                        { action: 'edit', resource: 'src/*', effect: 'deny' },
                        { action: '*', resource: '*', effect: 'allow' },
                    ],
                },
            ];
            const result = evaluateRules('edit', 'src/foo.ts', rulesets);
            expect(result.effect).toBe('deny');
            expect(result.matchedRule).toEqual({ action: 'edit', resource: 'src/*', effect: 'deny' });
        });
    });

    describe('last-match-wins', () => {
        it('picks the last matching rule when two rules match', () => {
            const denyRule: PolicyEffectRule = { action: 'edit', resource: 'src/*', effect: 'deny' };
            const allowRule: PolicyEffectRule = { action: 'edit', resource: '**', effect: 'allow' };

            const denyLast: PolicyEffectRuleSet[] = [{ rules: [allowRule, denyRule] }];
            expect(evaluateRules('edit', 'src/foo.ts', denyLast).effect).toBe('deny');

            const allowLast: PolicyEffectRuleSet[] = [{ rules: [denyRule, allowRule] }];
            expect(evaluateRules('edit', 'src/foo.ts', allowLast).effect).toBe('allow');
        });

        it('flattens multiple rulesets in order', () => {
            const rulesets: PolicyEffectRuleSet[] = [
                { id: 'base', rules: [{ action: 'read', resource: '**', effect: 'allow' }] },
                { id: 'override', rules: [{ action: 'read', resource: 'secret/*', effect: 'deny' }] },
            ];
            expect(evaluateRules('read', 'secret/key.txt', rulesets).effect).toBe('deny');
            expect(evaluateRules('read', 'src/foo.ts', rulesets).effect).toBe('allow');
        });
    });

    describe('no-match default', () => {
        it('returns ask with no matchedRule when no rule matches', () => {
            const rulesets: PolicyEffectRuleSet[] = [
                { rules: [{ action: 'read', resource: 'src/*', effect: 'allow' }] },
            ];
            const result = evaluateRules('edit', 'src/foo.ts', rulesets);
            const expected: EvaluationResult = { effect: 'ask' };
            expect(result).toEqual(expected);
        });

        it('returns ask for empty rulesets', () => {
            const result = evaluateRules('edit', 'src/foo.ts', []);
            expect(result.effect).toBe('ask');
            expect(result.matchedRule).toBeUndefined();
        });
    });

    describe('action glob matching', () => {
        it('matches a wildcard action pattern', () => {
            const rulesets: PolicyEffectRuleSet[] = [{ rules: [{ action: '*', resource: '**', effect: 'allow' }] }];
            expect(evaluateRules('edit', 'any/path/x.ts', rulesets).effect).toBe('allow');
            expect(evaluateRules('bash', 'cmd', rulesets).effect).toBe('allow');
        });
    });
});

describe('deriveChildPermissions', () => {
    it('forwards parent agent and session deny rules and injects nested-task deny', () => {
        const parentAgent: PolicyEffectRuleSet = {
            rules: [
                { action: 'edit', resource: 'locked/*', effect: 'deny' },
                { action: 'read', resource: '**', effect: 'allow' },
            ],
        };
        const parentSession: PolicyEffectRuleSet = {
            rules: [
                { action: 'bash', resource: 'prod/*', effect: 'deny' },
                { action: 'edit', resource: 'src/*', effect: 'allow' },
            ],
        };

        const child = deriveChildPermissions(parentAgent, parentSession);

        expect(child.rules).toEqual([
            { action: 'edit', resource: 'locked/*', effect: 'deny' },
            { action: 'bash', resource: 'prod/*', effect: 'deny' },
            { action: 'subagent', resource: '**', effect: 'deny' },
        ]);
    });

    it('injects nested-task deny even when no parent denies exist', () => {
        const parentAgent: PolicyEffectRuleSet = {
            rules: [{ action: 'read', resource: '**', effect: 'allow' }],
        };
        const parentSession: PolicyEffectRuleSet = {
            rules: [{ action: 'edit', resource: 'src/*', effect: 'allow' }],
        };

        const child = deriveChildPermissions(parentAgent, parentSession);

        expect(child.rules).toEqual([{ action: 'subagent', resource: '**', effect: 'deny' }]);
    });

    it('injects nested-task deny for empty parent rulesets', () => {
        const child = deriveChildPermissions({ rules: [] }, { rules: [] });

        expect(child.rules).toEqual([{ action: 'subagent', resource: '**', effect: 'deny' }]);
    });

    it('child cannot spawn nested subagents', () => {
        const child = deriveChildPermissions(
            { rules: [{ action: 'edit', resource: 'locked/*', effect: 'deny' }] },
            { rules: [] },
        );

        const result = evaluateRules('subagent', 'research the auth module', [child]);
        expect(result.effect).toBe('deny');
    });

    it('inherited parent deny blocks the child at evaluation time', () => {
        const parentAgent: PolicyEffectRuleSet = {
            rules: [{ action: 'edit', resource: 'locked/*', effect: 'deny' }],
        };
        const child = deriveChildPermissions(parentAgent, { rules: [] });

        expect(evaluateRules('edit', 'locked/secret.ts', [child]).effect).toBe('deny');
    });

    it('child allows pass through where parent did not deny', () => {
        const child = deriveChildPermissions(
            { rules: [{ action: 'edit', resource: 'locked/*', effect: 'deny' }] },
            { rules: [] },
        );
        const childOwnAllow: PolicyEffectRuleSet = {
            rules: [{ action: 'edit', resource: 'src/*', effect: 'allow' }],
        };

        const combined: PolicyEffectRuleSet[] = [childOwnAllow, child];
        expect(evaluateRules('edit', 'src/foo.ts', combined).effect).toBe('allow');
        expect(evaluateRules('edit', 'locked/secret.ts', combined).effect).toBe('deny');
    });
});
