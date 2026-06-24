import { describe, expect, it } from 'vitest';
import { formatToolCountSummary } from './interactive-coding-agent.js';

describe('formatToolCountSummary', () => {
    it('returns the name as-is for a single tool call', () => {
        expect(formatToolCountSummary(['file.patch'])).toBe('file.patch');
    });

    it('aggregates duplicate tool names with a multiplication sign', () => {
        expect(formatToolCountSummary(['file.patch', 'file.patch', 'file.patch'])).toBe('file.patch \u00d73');
    });

    it('preserves first-seen order across distinct tool names with counts', () => {
        expect(formatToolCountSummary(['bash.run', 'file.patch', 'bash.run', 'file.patch', 'bash.run'])).toBe(
            'bash.run \u00d73, file.patch \u00d72',
        );
    });

    it('lists distinct names without a count suffix when each appears once', () => {
        expect(formatToolCountSummary(['file.patch', 'bash.run', 'repo.read'])).toBe('file.patch, bash.run, repo.read');
    });

    it('caps the displayed entries at five and appends a remainder hint', () => {
        const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        expect(formatToolCountSummary(names)).toBe('a, b, c, d, e, +2 more');
    });

    it('does not cap when there are exactly five distinct entries', () => {
        const names = ['a', 'b', 'c', 'd', 'e'];
        expect(formatToolCountSummary(names)).toBe('a, b, c, d, e');
    });

    it('handles an empty list', () => {
        expect(formatToolCountSummary([])).toBe('');
    });
});
