import { describe, expect, it } from 'vitest';
import { terminalDisplayWidth } from '../terminal-text';
import { projectVisualGraphInputForDisplay } from './abg-display-projection';
import { renderVisualGraph, type VisualGraphNode, type VisualGraphRender } from './visual-graph';

function node(nodeId: string, status: VisualGraphNode['status'] = 'idle'): VisualGraphNode {
    return { nodeId, status, isActive: false };
}

function expectGraphWidth(result: VisualGraphRender, maxWidth: number): void {
    for (const line of result.lines) {
        expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(maxWidth);
    }
    for (const row of result.rows) {
        const joined = row.segments.map(({ text }) => text).join('');
        expect(terminalDisplayWidth(joined)).toBeLessThanOrEqual(maxWidth);
        for (const segment of row.segments) {
            expect(terminalDisplayWidth(segment.text)).toBeLessThanOrEqual(maxWidth);
        }
    }
}

describe('visual graph narrow text rendering', () => {
    it('clips placeholder and caller-limited summary rows before rows and lines are constructed', () => {
        const placeholderAtFour = renderVisualGraph({ nodes: [], edges: [], maxWidth: 4 });
        const placeholderAtOne = renderVisualGraph({ nodes: [], edges: [], maxWidth: 1 });
        const summaryInput = {
            nodes: Array.from({ length: 17 }, (_, index) => node(`node-${index}`)),
            edges: [],
            maxNodes: 16,
        };
        const summaryAtFour = renderVisualGraph({ ...summaryInput, maxWidth: 4 });
        const summaryAtTwelve = renderVisualGraph({ ...summaryInput, maxWidth: 12 });
        const summaryAtOne = renderVisualGraph({ ...summaryInput, maxWidth: 1 });

        expect(placeholderAtFour.lines).toEqual(['(no~']);
        expect(placeholderAtOne.lines).toEqual(['~']);
        expect(summaryAtTwelve.lines[0]).toBe('(graph too ~');
        expect(summaryAtOne.lines.every((line) => line === '~')).toBe(true);
        for (const [result, width] of [
            [placeholderAtFour, 4],
            [placeholderAtOne, 1],
            [summaryAtFour, 4],
            [summaryAtTwelve, 12],
            [summaryAtOne, 1],
        ] as const) {
            expectGraphWidth(result, width);
            expect(result.rows.map((row) => row.segments.map(({ text }) => text).join(''))).toEqual(result.lines);
        }
    });

    it('normalizes a nonpositive fractional maxWidth to one terminal column', () => {
        const result = renderVisualGraph({ nodes: [], edges: [], maxWidth: 0.9 });

        expect(result.width).toBe(1);
        expect(result.lines).toEqual(['~']);
        expectGraphWidth(result, 1);
    });

    it('keeps projected graph rows and 25 pan offsets grapheme-safe and bounded', () => {
        const rawInput = {
            nodes: [node('e\u0301家族👨‍👩‍👧‍👦\u202eunsafe', 'succeeded')],
            edges: [],
            maxWidth: 10,
        };
        const projected = projectVisualGraphInputForDisplay(rawInput);

        expectGraphWidth(renderVisualGraph(projected), 10);
        for (let offsetX = 0; offsetX < 25; offsetX += 1) {
            const rendered = renderVisualGraph({ ...projected, offsetX });
            const text = rendered.lines.join('\n');
            expectGraphWidth(rendered, 10);
            if (text.includes('\u0301')) expect(text).toContain('e\u0301');
            if (text.includes('👨') || text.includes('👩') || text.includes('👧') || text.includes('👦')) {
                expect(text).toContain('👨‍👩‍👧‍👦');
            }
        }
    });
});
