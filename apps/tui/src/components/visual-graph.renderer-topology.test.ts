import { describe, expect, it } from 'vitest';
import { terminalDisplayWidth } from '../terminal-text';
import { renderVisualGraph, type VisualGraphNode } from './visual-graph';

const WIDE = 100;

function node(nodeId: string, status: VisualGraphNode['status'], isActive = false): VisualGraphNode {
    return { nodeId, status, isActive };
}

function joinedLines(result: { readonly lines: readonly string[] }): string {
    return result.lines.join('\n');
}

describe('visual-graph topology rendering', () => {
    it('renders every fan-out endpoint once and connects each target', () => {
        const result = renderVisualGraph({
            nodes: [
                node('parent', 'succeeded'),
                node('child1', 'running', true),
                node('child2', 'idle'),
                node('child3', 'idle'),
            ],
            edges: [
                { from: 'parent', to: 'child1' },
                { from: 'parent', to: 'child2' },
                { from: 'parent', to: 'child3' },
            ],
            maxWidth: WIDE,
        });

        const text = joinedLines(result);
        expect(occurrences(text, 'parent')).toBe(1);
        expect(occurrences(text, 'child1')).toBe(1);
        expect(occurrences(text, 'child2')).toBe(1);
        expect(occurrences(text, 'child3')).toBe(1);
        expect(occurrences(text, '\u25bc')).toBe(3);
    });

    it('renders a fan-in target once while retaining both incoming connectors', () => {
        const result = renderVisualGraph({
            nodes: [node('a', 'succeeded'), node('b', 'succeeded'), node('c', 'running', true)],
            edges: [
                { from: 'a', to: 'c' },
                { from: 'b', to: 'c' },
            ],
            maxWidth: WIDE,
        });

        const text = joinedLines(result);
        expect(occurrences(text, 'c [running]')).toBe(1);
        expect(occurrences(text, '[running]')).toBe(1);
        expect(occurrences(text, 'a [')).toBe(1);
        expect(occurrences(text, 'b [')).toBe(1);
        expect(text).toContain('\u2502');
        expect(text).toContain('\u25bc');
    });

    it('renders self-loop markers', () => {
        const result = renderVisualGraph({
            nodes: [node('work', 'running', true)],
            edges: [{ from: 'work', to: 'work' }],
            maxWidth: WIDE,
        });

        expect(result.collapsed).toBe(false);
        expect(joinedLines(result)).toContain('\u21bb');
    });

    it('renders upward cycle arrows', () => {
        const result = renderVisualGraph({
            nodes: [node('a', 'running', true), node('b', 'idle'), node('c', 'idle')],
            edges: [
                { from: 'a', to: 'b' },
                { from: 'b', to: 'c' },
                { from: 'c', to: 'a' },
            ],
            maxWidth: WIDE,
        });

        const text = joinedLines(result);
        expect(text).toContain('a [');
        expect(text).toContain('b [');
        expect(text).toContain('c [');
        expect(text).toContain('\u25b2');
    });

    it('keeps disconnected nodes alongside connected components', () => {
        const result = renderVisualGraph({
            nodes: [node('a', 'succeeded'), node('b', 'idle'), node('orphan', 'idle')],
            edges: [{ from: 'a', to: 'b' }],
            maxWidth: WIDE,
        });

        const text = joinedLines(result);
        expect(text).toContain('orphan');
        expect(text).toContain('a [');
        expect(text).toContain('b [');
        expect(text).toContain('\u25bc');
    });

    it('clips long node labels without splitting terminal graphemes', () => {
        const longNodeId = 'x'.repeat(60);
        const result = renderVisualGraph({
            nodes: [node(longNodeId, 'running')],
            edges: [],
            maxWidth: WIDE,
        });

        expect(joinedLines(result)).toContain('\u2026');
        expect(joinedLines(result)).not.toContain(longNodeId);
    });

    it('clips long edge labels without splitting terminal graphemes', () => {
        const result = renderVisualGraph({
            nodes: [node('a', 'succeeded'), node('b', 'running')],
            edges: [{ from: 'a', to: 'b', label: 'a'.repeat(40) }],
            maxWidth: WIDE,
        });

        expect(joinedLines(result)).toContain('\u2026');
    });

    it('bounds every output line to maxWidth', () => {
        const narrow = 12;
        const result = renderVisualGraph({
            nodes: [node('start', 'succeeded'), node('end', 'idle')],
            edges: [{ from: 'start', to: 'end' }],
            maxWidth: narrow,
        });

        expect(result.collapsed).toBe(false);
        for (const line of result.lines) {
            expect(line.length).toBeLessThanOrEqual(narrow);
        }
        expect(result.width).toBe(narrow);
    });

    it('still surfaces node glyphs when clipped', () => {
        const result = renderVisualGraph({
            nodes: [node('start', 'succeeded')],
            edges: [],
            maxWidth: 8,
        });

        expect(joinedLines(result)).toContain('\u2713');
    });

    it('keeps CJK and ZWJ node labels within terminal-cell box widths', () => {
        const nodeId = '家族👨‍👩‍👧‍👦';
        const result = renderVisualGraph({
            nodes: [node(nodeId, 'succeeded')],
            edges: [],
            maxWidth: 22,
        });

        const contentLine = result.lines.find((line) => line.includes('[succeeded]'));
        expect(contentLine).toBeDefined();
        if (contentLine === undefined) return;
        expect(contentLine).toContain(nodeId);
        expect(terminalDisplayWidth(contentLine)).toBe(22);
        expect(result.lines.every((line) => terminalDisplayWidth(line) <= 22)).toBe(true);
    });

    it('keeps wide graphemes whole when a pan begins inside a terminal cell span', () => {
        const result = renderVisualGraph({
            nodes: [node('家族👨‍👩‍👧‍👦', 'succeeded')],
            edges: [],
            maxWidth: 10,
            offsetX: 5,
        });

        expect(joinedLines(result)).toContain('👨‍👩‍👧‍👦');
        expect(result.lines.every((line) => terminalDisplayWidth(line) <= 10)).toBe(true);
    });
});

function occurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
