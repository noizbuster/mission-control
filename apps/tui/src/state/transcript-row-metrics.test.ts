import { describe, expect, it } from 'vitest';
import {
    estimateLegacyBlockHeight,
    estimateTranscriptPartHeight,
    expandWindowToHeightBudget,
} from './transcript-row-metrics';
import type { TranscriptPart } from './transcript-part';

describe('estimateTranscriptPartHeight', () => {
    it('keeps status/inline tools compact and expands assistant/diff', () => {
        const status: TranscriptPart = { id: 's', type: 'status', text: 'ok' };
        const assistant: TranscriptPart = {
            id: 'a',
            type: 'assistant',
            text: `${'paragraph '.repeat(40)}\n\n${'more '.repeat(40)}`,
        };
        const diff: TranscriptPart = {
            id: 'd',
            type: 'diff',
            text: Array.from({ length: 30 }, (_, i) => `+line ${i}`).join('\n'),
        };
        expect(estimateTranscriptPartHeight(status)).toBe(1);
        expect(estimateTranscriptPartHeight(assistant)).toBeGreaterThan(estimateTranscriptPartHeight(status));
        expect(estimateTranscriptPartHeight(diff)).toBeGreaterThan(5);
    });

    it('uses block-tool output when it is available', () => {
        const blockTool: TranscriptPart = {
            id: 'tool',
            type: 'block-tool',
            text: 'summary',
            output: 'line\n'.repeat(10),
        };
        expect(estimateTranscriptPartHeight(blockTool)).toBeGreaterThan(5);
    });
});

describe('estimateLegacyBlockHeight', () => {
    it('counts wrapped lines', () => {
        expect(estimateLegacyBlockHeight({ lines: ['short'] })).toBeGreaterThanOrEqual(1);
        expect(estimateLegacyBlockHeight({ lines: ['x'.repeat(200)] }, 40)).toBeGreaterThan(3);
    });
});

describe('expandWindowToHeightBudget', () => {
    it('grows around the anchor until the height budget is met', () => {
        const heights = Array.from({ length: 50 }, () => 2);
        const window = expandWindowToHeightBudget({
            count: heights.length,
            anchorIndex: 25,
            viewportRows: 20,
            maxRows: 40,
            heightAt: (index) => heights[index] ?? 2,
            overscanRows: 2,
        });
        expect(window.endIndex - window.startIndex).toBeGreaterThan(10);
        expect(window.startIndex).toBeLessThanOrEqual(25);
        expect(window.endIndex).toBeGreaterThan(25);
    });

    it('never exceeds maxRows or list bounds', () => {
        const window = expandWindowToHeightBudget({
            count: 10,
            anchorIndex: 5,
            viewportRows: 100,
            maxRows: 6,
            heightAt: () => 1,
        });
        expect(window.startIndex).toBeGreaterThanOrEqual(0);
        expect(window.endIndex).toBeLessThanOrEqual(10);
        expect(window.endIndex - window.startIndex).toBeLessThanOrEqual(6);
    });
});
