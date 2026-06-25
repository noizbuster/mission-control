/**
 * Bracketed-paste markers + multiline robustness (T13).
 *
 * Pure-module test (no @opentui/core, no React, FFI-free). Covers the
 * acceptance criteria as pure round-trips: a marker-sized paste collapses to a
 * `[Paste #N, +M lines]` token, the store holds the full content, and
 * `expand` (the host re-insert hook called on submit) recovers the full text.
 *
 * The bridge wiring in `opentui-chat-bridge.tsx` is a thin glue layer over
 * these primitives: `bridgePaste` calls `evaluatePaste` + `makeMarker` +
 * `insertText` + `store`, and `bridgeSubmit` calls `store.expand(captured)`
 * before enqueuing. Verifying the primitives here verifies the contract the
 * bridge depends on; the bridge suite confirms no regression.
 */
import { describe, expect, it } from 'vitest';
import {
    countLines,
    decodePasteBytes,
    evaluatePaste,
    isMarkerSized,
    makeMarker,
    PASTE_CHAR_THRESHOLD,
    PASTE_LINE_THRESHOLD,
    PasteMarkerStore,
} from './bracketed-paste.js';

const encoder = new TextEncoder();

function makeLines(count: number): string {
    return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}

describe('bracketed-paste thresholds (isMarkerSized / evaluatePaste)', () => {
    it('markers a 15-line paste (> 10 lines)', () => {
        const text = makeLines(15);
        expect(isMarkerSized(text)).toBe(true);
        expect(evaluatePaste(text)).toEqual({
            kind: 'marker',
            lineCount: 15,
            charCount: text.length,
        });
    });

    it('does NOT marker a 3-line paste (literal insertion)', () => {
        const text = makeLines(3);
        expect(isMarkerSized(text)).toBe(false);
        expect(evaluatePaste(text)).toEqual({ kind: 'literal' });
    });

    it('markers a single huge line with no newline (> 1000 chars)', () => {
        const text = 'x'.repeat(1001);
        expect(countLines(text)).toBe(1);
        expect(isMarkerSized(text)).toBe(true);
        expect(evaluatePaste(text)).toEqual({
            kind: 'marker',
            lineCount: 1,
            charCount: 1001,
        });
    });

    it('does NOT marker a 1000-char / 10-line paste exactly at the boundary', () => {
        const text = makeLines(PASTE_LINE_THRESHOLD); // exactly 10 lines
        expect(isMarkerSized(text)).toBe(false);
        const boundary = 'x'.repeat(PASTE_CHAR_THRESHOLD); // exactly 1000 chars
        expect(isMarkerSized(boundary)).toBe(false);
    });

    it('is a no-op decision for an empty paste', () => {
        expect(isMarkerSized('')).toBe(false);
        expect(evaluatePaste('')).toEqual({ kind: 'literal' });
    });
});

describe('bracketed-paste makeMarker', () => {
    it('produces the lines form for a multi-line paste', () => {
        expect(makeMarker(1, 15, 200)).toBe('[Paste #1, +15 lines]');
    });

    it('produces the chars form for a single huge line (<= 10 lines)', () => {
        expect(makeMarker(2, 1, 1001)).toBe('[Paste #2, 1001 chars]');
    });

    it('increments the id in the token', () => {
        expect(makeMarker(7, 50, 9999)).toBe('[Paste #7, +50 lines]');
    });
});

describe('PasteMarkerStore store / has / expand / clear', () => {
    it('stores full content keyed by id and expands it back (acceptance a + b)', () => {
        const store = new PasteMarkerStore();
        const full = makeLines(15);

        store.store(1, full);

        expect(store.has(1)).toBe(true);
        expect(store.get(1)).toBe(full);
        // The host re-insert hook (submit) replaces the marker with the content.
        expect(store.expand('[Paste #1, +15 lines]')).toBe(full);
    });

    it('expands a marker embedded in surrounding text, preserving context', () => {
        const store = new PasteMarkerStore();
        const full = makeLines(20);
        store.store(3, full);

        const submitted = `before ${makeMarker(3, 20, full.length)} after`;
        expect(store.expand(submitted)).toBe(`before ${full} after`);
    });

    it('expands multiple distinct markers in one submission', () => {
        const store = new PasteMarkerStore();
        const a = makeLines(12);
        const b = 'y'.repeat(2000);
        store.store(1, a);
        store.store(2, b);

        const submitted = `${makeMarker(1, 12, a.length)} then ${makeMarker(2, 1, b.length)}`;
        expect(store.expand(submitted)).toBe(`${a} then ${b}`);
    });

    it('falls back to the literal marker text when no content is stored (stale state)', () => {
        const store = new PasteMarkerStore();
        // Marker #99 was never stored (e.g. store cleared / id drifted).
        expect(store.expand('[Paste #99, +50 lines]')).toBe('[Paste #99, +50 lines]');
        expect(store.expand('keep [Paste #5] too')).toBe('keep [Paste #5] too');
    });

    it('leaves non-marker text untouched', () => {
        const store = new PasteMarkerStore();
        store.store(1, makeLines(15));
        expect(store.expand('hello world')).toBe('hello world');
        expect(store.expand('[Not a paste]')).toBe('[Not a paste]');
    });

    it('clear() drops all stored content (markers fall back to literal)', () => {
        const store = new PasteMarkerStore();
        const full = makeLines(15);
        store.store(1, full);
        expect(store.expand(makeMarker(1, 15, full.length))).toBe(full);

        store.clear();

        expect(store.has(1)).toBe(false);
        expect(store.expand(makeMarker(1, 15, full.length))).toBe(makeMarker(1, 15, full.length));
    });
});

describe('decodePasteBytes', () => {
    it('decodes UTF-8 paste bytes to a string', () => {
        const text = makeLines(15);
        expect(decodePasteBytes(encoder.encode(text))).toBe(text);
    });

    it('decodes an empty byte array to an empty string', () => {
        expect(decodePasteBytes(new Uint8Array())).toBe('');
    });

    it('preserves multibyte content (CJK) across decode + marker round-trip', () => {
        const text = '日本語\n'.repeat(12).trimEnd();
        const bytes = encoder.encode(text);
        const store = new PasteMarkerStore();
        store.store(1, decodePasteBytes(bytes));
        expect(store.expand(makeMarker(1, countLines(text), text.length))).toBe(text);
    });
});

describe('end-to-end paste -> marker -> submit -> expand (acceptance a-d)', () => {
    // Simulates the bridge flow without mounting opentui: evaluatePaste decides,
    // makeMarker builds the token, the store holds the content, and expand
    // (called by bridgeSubmit) recovers it on submit.
    function simulatePaste(text: string, store: PasteMarkerStore, nextId: () => number): string {
        const decision = evaluatePaste(text);
        if (decision.kind === 'literal') return text; // native literal insertion
        const id = nextId();
        store.store(id, text);
        return makeMarker(id, decision.lineCount, decision.charCount);
    }

    it('(a) a 15-line paste collapses to a marker and the store holds the full text', () => {
        const store = new PasteMarkerStore();
        let counter = 0;
        const full = makeLines(15);

        const visible = simulatePaste(full, store, () => ++counter);

        expect(visible).toBe('[Paste #1, +15 lines]');
        expect(store.has(1)).toBe(true);
        expect(store.get(1)).toBe(full);
    });

    it('(b) submitting the visible marker expands it to the full content', () => {
        const store = new PasteMarkerStore();
        let counter = 0;
        const full = makeLines(15);
        const visible = simulatePaste(full, store, () => ++counter);

        const submitted = store.expand(visible);

        expect(submitted).toBe(full);
    });

    it('(c) a 3-line paste is inserted literally (no marker, no store entry)', () => {
        const store = new PasteMarkerStore();
        let counter = 0;
        const text = makeLines(3);

        const visible = simulatePaste(text, store, () => ++counter);

        expect(visible).toBe(text);
        expect(counter).toBe(0);
        expect(store.has(1)).toBe(false);
    });

    it('(d) a marker with no stored content falls back to the literal token', () => {
        const store = new PasteMarkerStore();
        // Nothing stored under id 1 — submit must not crash or drop the token.
        expect(store.expand('see [Paste #1, +15 lines] here')).toBe('see [Paste #1, +15 lines] here');
    });
});
