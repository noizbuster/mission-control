import { describe, expect, it } from 'vitest';
import { createNativesClient, type NativesClient } from '../native/natives-client';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const defaultAddonPath = join(root, 'native', 'natives', 'index.node');
// The native addon is an optional build artifact; CI may run without it. The
// parity tests assert real N-API behavior when it is present and are skipped
// otherwise so the suite stays green in addon-less environments. The fallback
// (null-return) tests always run.
const addonBuilt = existsSync(defaultAddonPath);

function makeClient(): NativesClient {
    return createNativesClient({ addonPath: defaultAddonPath, onWarning: () => {} });
}

function fixtureDir(): string {
    const dir = join(tmpdir(), `mc-napi-parity-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function writeFixture(dir: string, name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
}

describe('N-API ast/html/highlight parity (task 8)', () => {
    describe('astGrep native path', () => {
        it.skipIf(!addonBuilt)('returns console.log matches with 1-indexed positions and metaVariables', () => {
            const client = makeClient();
            const dir = fixtureDir();
            const file = writeFixture(dir, 'sample.ts', "console.log('hi');\nconst x = 1;\nconsole.log(x);\n");
            try {
                const result = client.astGrep('console.log($X)', [file], { includeMeta: true });
                expect(result).not.toBeNull();
                const matches = result?.matches ?? [];
                expect(matches.length).toBe(2);
                expect(matches[0]?.text.startsWith('console.log')).toBe(true);
                expect(matches[0]?.startLine).toBeGreaterThanOrEqual(1);
                expect(matches[0]?.startColumn).toBeGreaterThanOrEqual(1);
                expect(matches[0]?.metaVariables?.['X']).toBe("'hi'");
                expect(result?.filesWithMatches).toBe(1);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it.skipIf(!addonBuilt)('skips files with unsupported extensions', () => {
            const client = makeClient();
            const dir = fixtureDir();
            const tsFile = writeFixture(dir, 'a.ts', 'console.log(1);\n');
            const mdFile = writeFixture(dir, 'b.md', 'console.log(1);\n');
            try {
                const result = client.astGrep('console.log($X)', [mdFile, tsFile], { includeMeta: true });
                expect(result?.matches.length).toBe(1);
                expect(result?.filesSearched).toBe(1);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it.skipIf(!addonBuilt)('surfaces a clear parse error (not a crash) for a multi-statement pattern', () => {
            const client = makeClient();
            const dir = fixtureDir();
            const file = writeFixture(dir, 'a.ts', 'const x = 1;\n');
            try {
                const result = client.astGrep('a(1); b(2);', [file], {});
                // Compile failure is non-fatal: collected in parseErrors, no throw.
                expect(result).not.toBeNull();
                expect(result?.parseErrors?.some((e) => e.includes('compile failed'))).toBe(true);
                expect(result?.matches.length).toBe(0);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('returns null (fallback) when the addon path does not exist', () => {
            const client = createNativesClient({ addonPath: '/nonexistent/natives.node' });
            expect(client.astGrep('console.log($X)', ['/tmp/x.ts'], {})).toBeNull();
        });
    });

    describe('htmlToMarkdown native path', () => {
        it.skipIf(!addonBuilt)('converts an HTML sample to markdown', () => {
            const client = makeClient();
            const md = client.htmlToMarkdown('<h1>Title</h1><p>Hello <strong>world</strong></p>');
            expect(md).not.toBeNull();
            expect(md).toContain('Title');
            expect(md).toContain('world');
        });

        it.skipIf(!addonBuilt)('handles malformed HTML without crashing', () => {
            const client = makeClient();
            const md = client.htmlToMarkdown('<broken');
            expect(md).not.toBeNull();
        });

        it('returns null (fallback) when the addon path does not exist', () => {
            const client = createNativesClient({ addonPath: '/nonexistent/natives.node' });
            expect(client.htmlToMarkdown('<p>x</p>')).toBeNull();
        });
    });

    describe('highlightCode native path', () => {
        it.skipIf(!addonBuilt)('returns ANSI-colored output for a TypeScript snippet', () => {
            const client = makeClient();
            const colors = {
                comment: '\x1b[38;2;120;120;120m',
                keyword: '\x1b[38;2;255;0;128m',
                function: '\x1b[38;2;0;128;255m',
                variable: '\x1b[38;2;200;200;200m',
                string: '\x1b[38;2;0;200;0m',
                number: '\x1b[38;2;200;200;0m',
                type: '\x1b[38;2;128;128;255m',
                operator: '\x1b[38;2;255;128;0m',
                punctuation: '\x1b[38;2;160;160;160m',
            };
            const out = client.highlightCode('const x = 1;', 'typescript', colors);
            expect(out).not.toBeNull();
            expect(out).toContain('\x1b[');
            expect(out).toContain('const');
        });

        it.skipIf(!addonBuilt)('returns raw text (no ANSI) for an unknown language', () => {
            const client = makeClient();
            const colors = {
                comment: '\x1b[38;2;120;120;120m',
                keyword: '',
                function: '',
                variable: '',
                string: '',
                number: '',
                type: '',
                operator: '',
                punctuation: '',
            };
            const out = client.highlightCode('const x = 1;', 'totally-unknown-lang', colors);
            expect(out).not.toBeNull();
            expect(out).not.toContain('\x1b[');
        });

        it('returns null (fallback) when the addon path does not exist', () => {
            const client = createNativesClient({ addonPath: '/nonexistent/natives.node' });
            expect(
                client.highlightCode('x', 'ts', {
                    comment: '',
                    keyword: '',
                    function: '',
                    variable: '',
                    string: '',
                    number: '',
                    type: '',
                    operator: '',
                    punctuation: '',
                }),
            ).toBeNull();
        });
    });
});
