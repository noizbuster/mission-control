import { describe, expect, it } from 'vitest';
import { assertValidPlanSlug, isValidPlanSlug, type PlanContent, PlanFormatError, writePlan } from './plan-format.js';
import { parsePlanChecklistText } from './plan-store.js';

function sampleContent(overrides: Partial<PlanContent> = {}): PlanContent {
    return {
        tldr: 'Add a search command that reads durable session logs and returns matching excerpts.',
        todos: ['Add protocol schema for search results', 'Implement searchSessions in core', 'Wire CLI subcommand'],
        finalWave: [
            'Reviewer: confirm JSON output validates against schema',
            'Reviewer: confirm no session logs are mutated',
        ],
        ...overrides,
    };
}

/** Run `action` and return the thrown value, or fail the test if nothing threw. */
function captureError(action: () => unknown): unknown {
    try {
        action();
    } catch (error) {
        return error;
    }
    throw new Error('Expected the action to throw, but it did not throw');
}

describe('isValidPlanSlug', () => {
    it('accepts lowercase alphanumeric with single hyphens', () => {
        expect(isValidPlanSlug('add-session-search')).toBe(true);
        expect(isValidPlanSlug('phase3')).toBe(true);
        expect(isValidPlanSlug('fix-42-bug')).toBe(true);
        expect(isValidPlanSlug('a')).toBe(true);
    });

    it('rejects uppercase, underscores, and empty strings', () => {
        expect(isValidPlanSlug('CamelCase')).toBe(false);
        expect(isValidPlanSlug('with_underscore')).toBe(false);
        expect(isValidPlanSlug('')).toBe(false);
        expect(isValidPlanSlug('with space')).toBe(false);
        expect(isValidPlanSlug('../escape')).toBe(false);
    });

    it('rejects leading, trailing, or consecutive hyphens', () => {
        expect(isValidPlanSlug('-leading')).toBe(false);
        expect(isValidPlanSlug('trailing-')).toBe(false);
        expect(isValidPlanSlug('double--hyphen')).toBe(false);
    });
});

describe('assertValidPlanSlug', () => {
    it('does not throw for a valid slug', () => {
        expect(() => assertValidPlanSlug('valid-slug-1')).not.toThrow();
    });

    it('throws PlanFormatError with plan_invalid_slug code for an invalid slug', () => {
        const error = captureError(() => assertValidPlanSlug('Bad_Slug'));
        expect(error).toBeInstanceOf(PlanFormatError);
        expect(error).toMatchObject({ code: 'plan_invalid_slug' });
    });
});

describe('writePlan markdown output', () => {
    it('produces a title and all three required section headings', () => {
        // Given
        const content = sampleContent();

        // When
        const markdown = writePlan('demo-plan', content);

        // Then
        expect(markdown.startsWith('# demo-plan\n')).toBe(true);
        expect(markdown).toContain('## TL;DR');
        expect(markdown).toContain('## TODOs');
        expect(markdown).toContain('## Final Verification Wave');
    });

    it('renders the TL;DR body verbatim after the heading', () => {
        // Given
        const tldr = 'A short summary spanning one line.';
        const content = sampleContent({ tldr });

        // When
        const markdown = writePlan('demo-plan', content);

        // Then
        const tldrBlock = markdown.slice(markdown.indexOf('## TL;DR'), markdown.indexOf('## TODOs'));
        expect(tldrBlock).toContain('A short summary spanning one line.');
    });

    it('renders every todo as an unchecked column-0 checkbox', () => {
        // Given
        const content = sampleContent({
            todos: ['first task', 'second task', 'third task'],
        });

        // When
        const markdown = writePlan('demo-plan', content);

        // Then
        expect(markdown).toContain('- [ ] first task');
        expect(markdown).toContain('- [ ] second task');
        expect(markdown).toContain('- [ ] third task');
        // No checked boxes in a fresh plan.
        expect(markdown).not.toMatch(/^- \[x\]/mu);
    });

    it('renders every final-wave item as an unchecked column-0 checkbox', () => {
        // Given
        const content = sampleContent({
            finalWave: ['Reviewer: check A', 'Reviewer: check B'],
        });

        // When
        const markdown = writePlan('demo-plan', content);

        // Then
        expect(markdown).toContain('- [ ] Reviewer: check A');
        expect(markdown).toContain('- [ ] Reviewer: check B');
    });

    it('collapses newlines inside a checkbox item into spaces', () => {
        // Given
        const content = sampleContent({
            todos: ['line one\nline two'],
            finalWave: ['reviewer\nmulti\nline'],
        });

        // When
        const markdown = writePlan('demo-plan', content);

        // Then
        expect(markdown).toContain('- [ ] line one line two');
        expect(markdown).toContain('- [ ] reviewer multi line');
    });

    it('ends with a trailing newline', () => {
        // Given
        const content = sampleContent();

        // When
        const markdown = writePlan('demo-plan', content);

        // Then
        expect(markdown.endsWith('\n')).toBe(true);
    });
});

describe('writePlan round-trip with parsePlanChecklistText', () => {
    it('parsePlanChecklistText counts all todos plus final-wave items as unchecked', () => {
        // Given
        const content = sampleContent({
            todos: ['todo A', 'todo B', 'todo C'],
            finalWave: ['review X', 'review Y'],
        });

        // When
        const markdown = writePlan('round-trip-test', content);
        const checklist = parsePlanChecklistText(markdown);

        // Then
        expect(checklist.total).toBe(5);
        expect(checklist.completed).toBe(0);
        expect(checklist.unchecked).toBe(5);
    });

    it('parsePlanChecklistText preserves checkbox text in order', () => {
        // Given
        const content = sampleContent({
            todos: ['alpha', 'beta'],
            finalWave: ['gamma', 'delta'],
        });

        // When
        const markdown = writePlan('order-test', content);
        const checklist = parsePlanChecklistText(markdown);

        // Then
        expect(checklist.items.map((item) => item.text)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    });

    it('round-trips correctly when todos and finalWave have different counts', () => {
        // Given
        const content = sampleContent({
            todos: ['only one todo'],
            finalWave: ['f1', 'f2', 'f3', 'f4'],
        });

        // When
        const markdown = writePlan('uneven-test', content);
        const checklist = parsePlanChecklistText(markdown);

        // Then
        expect(checklist.total).toBe(5);
        expect(checklist.unchecked).toBe(5);
    });
});

describe('writePlan input validation', () => {
    it('throws PlanFormatError for an invalid slug', () => {
        // Given
        const content = sampleContent();

        // When / Then
        const error = captureError(() => writePlan('Invalid_Slug', content));
        expect(error).toBeInstanceOf(PlanFormatError);
        expect(error).toMatchObject({ code: 'plan_invalid_slug' });
    });

    it('throws PlanFormatError for an empty TL;DR', () => {
        // Given
        const content = sampleContent({ tldr: '   ' });

        // When / Then
        const error = captureError(() => writePlan('demo-plan', content));
        expect(error).toBeInstanceOf(PlanFormatError);
        expect(error).toMatchObject({ code: 'plan_empty_field' });
    });

    it('throws PlanFormatError for empty todos array', () => {
        // Given
        const content = sampleContent({ todos: [] });

        // When / Then
        const error = captureError(() => writePlan('demo-plan', content));
        expect(error).toBeInstanceOf(PlanFormatError);
        expect(error).toMatchObject({ code: 'plan_empty_field' });
    });

    it('throws PlanFormatError for empty finalWave array', () => {
        // Given
        const content = sampleContent({ finalWave: [] });

        // When / Then
        const error = captureError(() => writePlan('demo-plan', content));
        expect(error).toBeInstanceOf(PlanFormatError);
        expect(error).toMatchObject({ code: 'plan_empty_field' });
    });

    it('throws PlanFormatError when a todo item is whitespace-only', () => {
        // Given
        const content = sampleContent({ todos: ['valid', '   '] });

        // When / Then
        const error = captureError(() => writePlan('demo-plan', content));
        expect(error).toBeInstanceOf(PlanFormatError);
        expect(error).toMatchObject({ code: 'plan_empty_field' });
    });
});
