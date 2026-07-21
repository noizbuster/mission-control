import { describe, expect, it } from 'vitest';
import { READONLY_TASK_CHILD_CONTEXT } from './readonly-task-child-context';

describe('READONLY_TASK_CHILD_CONTEXT', () => {
    it('is a non-empty string', () => {
        expect(typeof READONLY_TASK_CHILD_CONTEXT).toBe('string');
        expect(READONLY_TASK_CHILD_CONTEXT.length).toBeGreaterThan(0);
    });

    it('names required structural tokens for child framing and verification', () => {
        const text = READONLY_TASK_CHILD_CONTEXT;
        for (const token of ['explore', 'librarian', 'TASK', 'DELIVERABLE', 'SCOPE', 'VERIFY', 'claims'] as const) {
            expect(text.toLowerCase()).toContain(token.toLowerCase());
        }
    });

    it('states children do not inherit workflow mode policies and names child authority', () => {
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/do NOT inherit workflow PolicyEffectRule/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/mode policies/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/selected read-only category/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/AgentDefinition\.pathPolicies/);
    });

    it('routes read-only parents to explore/librarian/oracle/reviewer/planner', () => {
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/explore/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/librarian/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/oracle/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/reviewer/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/planner/i);
    });

    it('does not list category:"deep" as a preferred route', () => {
        // Negative guidance ("not deep") is allowed; preferred-route examples must not.
        expect(READONLY_TASK_CHILD_CONTEXT).not.toMatch(/category\s*:\s*["']deep["']/i);
        expect(READONLY_TASK_CHILD_CONTEXT).not.toMatch(
            /prefer\s+(?:to\s+)?(?:route\s+to\s+)?deep\b|route\s+task\(\)\s+to\s+deep\b/i,
        );
    });

    it('does not mention planner-readonly mode by name', () => {
        expect(READONLY_TASK_CHILD_CONTEXT).not.toMatch(/planner-readonly/i);
        expect(READONLY_TASK_CHILD_CONTEXT).not.toMatch(/Planner-readonly/);
    });

    it('notes librarian/oracle network tools when category allows', () => {
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/webfetch/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/web_search/i);
        expect(READONLY_TASK_CHILD_CONTEXT).toMatch(/mcp/i);
    });
});
