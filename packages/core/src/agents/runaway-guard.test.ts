import { describe, expect, it } from 'vitest';
import {
    type BudgetAction,
    DEFAULT_SOFT_REQUEST_BUDGET,
    formatSalvageSnippet,
    RunawayGuard,
    SOFT_REQUEST_BUDGET,
} from './runaway-guard.js';

describe('SOFT_REQUEST_BUDGET', () => {
    it('ships the oh-my-pi budget defaults (explore=40, quick=40, default=90)', () => {
        expect(SOFT_REQUEST_BUDGET).toMatchObject({
            explore: 40,
            quick: 40,
            default: 90,
        });
    });
});

describe('RunawayGuard.trackRequest — each message_end increments requestCount', () => {
    it('counts three assistant requests into requestCount', () => {
        // Ported from oh-my-pi task-guards.test.ts:147 "counts assistant
        // requests into SingleResult.requests". Three message_end events ->
        // requestCount 3, and well under any budget so no steer injected.
        const guard = new RunawayGuard('explore');

        guard.trackRequest();
        guard.trackRequest();
        guard.trackRequest();

        expect(guard.requestCount).toBe(3);
        expect(guard.checkBudget().action).toBe('continue');
        expect(guard.hasSentSteer).toBe(false);
    });

    it('starts at zero requests and continues', () => {
        const guard = new RunawayGuard('default');
        expect(guard.requestCount).toBe(0);
        expect(guard.checkBudget().action).toBe('continue');
    });
});

describe('RunawayGuard.checkBudget — soft budget crosses once, then stays quiet under 1.5x', () => {
    it('injects exactly one steer when the soft budget is crossed and does not repeat', () => {
        // Ported from oh-my-pi task-guards.test.ts:167 "injects exactly one
        // steering notice when the soft budget is crossed". Budget 4: steer
        // fires at request 4 and must not repeat at request 5 (still below
        // the 1.5x hard stop of 6).
        const guard = new RunawayGuard('default', 4);

        // Requests 1-3: under budget, continue.
        for (let i = 1; i <= 3; i++) {
            guard.trackRequest();
            expect(guard.checkBudget().action).toBe('continue');
        }
        expect(guard.hasSentSteer).toBe(false);

        // Request 4: crosses soft budget -> steer fires exactly once.
        guard.trackRequest();
        const steerDecision = guard.checkBudget();
        expect(steerDecision.action).toBe<BudgetAction>('steer');
        expect(steerDecision.reason).toBeUndefined();
        expect(guard.hasSentSteer).toBe(true);

        // Request 5: still under 1.5x (6), steer must NOT repeat.
        guard.trackRequest();
        const afterDecision = guard.checkBudget();
        expect(afterDecision.action).toBe('continue');
        expect(guard.hasSentSteer).toBe(true);
        expect(guard.requestCount).toBe(5);
    });

    it('does not steer before the soft budget is reached', () => {
        const guard = new RunawayGuard('default', 5);
        for (let i = 1; i <= 4; i++) {
            guard.trackRequest();
            expect(guard.checkBudget().action).toBe('continue');
        }
        expect(guard.hasSentSteer).toBe(false);
    });

    it('uses the category budget when no explicit softBudget is given (explore=40)', () => {
        const guard = new RunawayGuard('explore');
        expect(guard.softBudget).toBe(40);
        for (let i = 1; i <= 39; i++) {
            guard.trackRequest();
            expect(guard.checkBudget().action).toBe('continue');
        }
        guard.trackRequest();
        expect(guard.checkBudget().action).toBe('steer');
    });

    it('falls back to the default budget for unknown agent names', () => {
        const guard = new RunawayGuard('unknown-category');
        expect(guard.softBudget).toBe(DEFAULT_SOFT_REQUEST_BUDGET);
    });
});

describe('RunawayGuard.checkBudget — 1.5x budget triggers graceful abort', () => {
    it('aborts at 1.5x the soft budget with the canonical abort reason', () => {
        // Ported from oh-my-pi task-guards.test.ts:193 "aborts the run
        // gracefully at 1.5x the soft budget". Budget 2: steer at 2, hard
        // stop at 3.
        const guard = new RunawayGuard('default', 2);

        guard.trackRequest();
        expect(guard.checkBudget().action).toBe('continue');

        guard.trackRequest();
        const steerDecision = guard.checkBudget();
        expect(steerDecision.action).toBe('steer');

        guard.trackRequest();
        const abortDecision = guard.checkBudget();
        expect(abortDecision.action).toBe<BudgetAction>('abort');
        expect(abortDecision.reason).toContain('request budget exceeded');
    });

    it('keeps aborting once the 1.5x threshold is crossed (idempotent signal)', () => {
        const guard = new RunawayGuard('default', 2);
        for (let i = 0; i < 3; i++) guard.trackRequest();

        const first = guard.checkBudget();
        const second = guard.checkBudget();
        expect(first.action).toBe('abort');
        expect(second.action).toBe('abort');
        expect(first.reason).toBe('request budget exceeded');
    });
});

describe('formatSalvageSnippet — aborted child output', () => {
    it('salvages the last assistant text with whitespace flattened onto a single line', () => {
        // Ported from oh-my-pi task-guards.test.ts:216 "salvages the last
        // assistant text for an aborted child with no completed output".
        // The original message content had embedded newlines and tabs which
        // must collapse to single spaces so the summary stays one line.
        const result = formatSalvageSnippet(1, 'Reading   the\n\tconfig loader before patching', 150);

        expect(result).toContain('cancelled after 1 req');
        expect(result).toContain('150 tok');
        expect(result).toContain('last activity:');
        expect(result).toContain('Reading the config loader before patching');
        expect(result).not.toContain('\n');
        expect(result).not.toContain('\t');
    });

    it('formats the full salvage line shape: [cancelled after N req, M tok … last activity: <snippet>]', () => {
        const result = formatSalvageSnippet(2, 'all done', 88);
        expect(result).toBe('[cancelled after 2 req, 88 tok … last activity: all done]');
    });

    it('clips oversized salvage snippets to <= 700 chars with an ellipsis marker', () => {
        // Ported from oh-my-pi task-guards.test.ts:245 "clips oversized
        // salvage snippets". The original 714-char input must be clipped,
        // keep its prefix, gain the ellipsis marker, and never leak the
        // full text.
        const longText = `start-marker ${'x'.repeat(700)}`;
        expect(longText.length).toBeGreaterThan(700);

        const result = formatSalvageSnippet(1, longText, 10);

        expect(result).toContain('start-marker');
        expect(result).toContain('…');
        expect(result).not.toContain(longText);

        // Snippet portion (between "last activity: " and the trailing "]")
        // must stay within the ~700 char budget.
        const snippetStart = result.indexOf('last activity: ') + 'last activity: '.length;
        const snippet = result.slice(snippetStart, -1);
        expect(snippet.length).toBeLessThanOrEqual(700);
        expect(snippet.endsWith('…')).toBe(true);
    });

    it('falls back to (no output) when there is no assistant text', () => {
        // Ported from oh-my-pi task-guards.test.ts:267 "formats the (no
        // output) fallback with the request count". Without any salvageable
        // text the summary still records the request count.
        expect(formatSalvageSnippet(7, undefined, 0)).toBe('[cancelled after 7 req, (no output)]');
        expect(formatSalvageSnippet(7, '', 0)).toBe('[cancelled after 7 req, (no output)]');
    });

    it('falls back to (no output) when the assistant text is whitespace-only', () => {
        expect(formatSalvageSnippet(3, '   \n\t  ', 0)).toBe('[cancelled after 3 req, (no output)]');
    });

    it('renders the token count as "?" when it is not known', () => {
        const result = formatSalvageSnippet(1, 'partial');
        expect(result).toBe('[cancelled after 1 req, ? tok … last activity: partial]');
    });
});
