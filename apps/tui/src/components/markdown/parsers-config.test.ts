import { describe, expect, it } from 'vitest';
import { TREE_SITTER_PARSERS } from './parsers-config.js';

// Pure-data inspection: no network, no opentui FFI. Just asserts the ported
// array matches the documented contract (count in the 30s, no `queries.locals`,
// required fields present on every entry).
describe('TREE_SITTER_PARSERS', () => {
    it('has an entry count in the 30s', () => {
        expect(TREE_SITTER_PARSERS.length).toBeGreaterThanOrEqual(30);
        expect(TREE_SITTER_PARSERS.length).toBeLessThanOrEqual(39);
    });

    it('never includes a `queries.locals` key on any entry', () => {
        for (const entry of TREE_SITTER_PARSERS) {
            // opentui's FiletypeParserOptions.queries only has highlights and
            // injections; any `locals` key would be dead data (and a type
            // error). Inspect the raw shape, not the typed view.
            expect('locals' in entry.queries).toBe(false);
            expect(Object.hasOwn(entry.queries, 'locals')).toBe(false);
        }
    });

    it('every entry has a non-empty filetype, a non-empty wasm URL, and a non-empty highlights array', () => {
        for (const entry of TREE_SITTER_PARSERS) {
            expect(entry.filetype, 'filetype must be a non-empty string').toMatch(/^\S+$/);
            expect(entry.wasm, 'wasm must be a non-empty URL string').toMatch(/^https?:\/\//);
            expect(Array.isArray(entry.queries.highlights), 'highlights must be an array').toBe(true);
            expect(entry.queries.highlights.length, 'highlights must be non-empty').toBeGreaterThan(0);
            for (const url of entry.queries.highlights) {
                expect(url, 'each highlights entry must be an http(s) URL').toMatch(/^https?:\/\//);
            }
        }
    });

    it('omits the languages opentui bundles natively (javascript, typescript, markdown, markdown_inline)', () => {
        const filetypes = new Set(TREE_SITTER_PARSERS.map((entry) => entry.filetype));
        expect(filetypes.has('javascript')).toBe(false);
        expect(filetypes.has('typescript')).toBe(false);
        expect(filetypes.has('markdown')).toBe(false);
        expect(filetypes.has('markdown_inline')).toBe(false);
    });
});
