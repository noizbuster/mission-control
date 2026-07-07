import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NativesClient } from '../native/natives-client.js';
import { extractSiteContent } from './web-search-extraction.js';

describe('extractSiteContent', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    const signal = new AbortController().signal;

    it('extracts structured markdown from an npm package URL via the registry API', async () => {
        globalThis.fetch = ((_url) => {
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        name: 'express',
                        description: 'Fast web framework',
                        version: '4.18.0',
                        license: 'MIT',
                        homepage: 'https://expressjs.com',
                        keywords: ['http', 'server'],
                        dependencies: { accepts: '~1.3.8' },
                        readme: '# Express\n\nNode web framework.',
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            );
        }) as typeof globalThis.fetch;

        const result = await extractSiteContent('https://www.npmjs.com/package/express', undefined, signal);

        expect(result).toBeDefined();
        expect(result!.method).toBe('npm');
        expect(result!.markdown).toContain('# express');
        expect(result!.markdown).toContain('Fast web framework');
        expect(result!.markdown).toContain('**Version:** 4.18.0');
        expect(result!.markdown).toContain('**License:** MIT');
        expect(result!.markdown).toContain('## README');
    });

    it('extracts structured markdown from a PyPI project URL', async () => {
        globalThis.fetch = ((_url) => {
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        info: {
                            name: 'requests',
                            summary: 'Python HTTP for Humans',
                            version: '2.31.0',
                            license: 'Apache 2.0',
                            author: 'Kenneth Reitz',
                            requires_dist: ['urllib3<3,>=1.21.1'],
                            description: 'Full description here.',
                        },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            );
        }) as typeof globalThis.fetch;

        const result = await extractSiteContent('https://pypi.org/project/requests/', undefined, signal);

        expect(result).toBeDefined();
        expect(result!.method).toBe('pypi');
        expect(result!.markdown).toContain('# requests');
        expect(result!.markdown).toContain('Python HTTP for Humans');
        expect(result!.markdown).toContain('## Requires');
    });

    it('extracts structured markdown from a crates.io URL', async () => {
        globalThis.fetch = ((_url) => {
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        crate: {
                            name: 'serde',
                            description: 'serialization framework',
                            max_version: '1.0.0',
                            license: 'MIT OR Apache-2.0',
                            downloads: 250000000,
                            repository: 'https://github.com/serde-rs/serde',
                            keywords: ['serialization'],
                            readme: '# Serde\n\nGeneric serialization.',
                        },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            );
        }) as typeof globalThis.fetch;

        const result = await extractSiteContent('https://crates.io/crates/serde', undefined, signal);

        expect(result).toBeDefined();
        expect(result!.method).toBe('crates.io');
        expect(result!.markdown).toContain('# serde');
        expect(result!.markdown).toContain('serialization framework');
        expect(result!.markdown).toContain('**Repository:** https://github.com/serde-rs/serde');
    });

    it('extracts repo metadata from a GitHub URL via the API', async () => {
        globalThis.fetch = ((url) => {
            const target = String(url);
            if (target.includes('api.github.com/repos')) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            full_name: 'vuejs/core',
                            description: 'The progressive UI framework.',
                            stargazers_count: 220000,
                            forks_count: 45000,
                            language: 'JavaScript',
                            license: { spdx_id: 'MIT' },
                            default_branch: 'main',
                            topics: ['javascript', 'ui'],
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    ),
                );
            }
            return Promise.resolve(new Response('# Vue\n\nA progressive framework.', { status: 200 }));
        }) as typeof globalThis.fetch;

        const result = await extractSiteContent('https://github.com/vuejs/core', undefined, signal);

        expect(result).toBeDefined();
        expect(result!.method).toBe('github');
        expect(result!.markdown).toContain('# vuejs/core');
        expect(result!.markdown).toContain('Stars:');
        expect(result!.markdown).toContain('## README');
    });

    it('falls back to generic HTML extraction for unknown hosts via the NativesClient', async () => {
        globalThis.fetch = ((_url) => {
            return Promise.resolve(
                new Response('<html><body><h1>Title</h1><p>Some content here.</p></body></html>', {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                }),
            );
        }) as typeof globalThis.fetch;

        const mockNatives: Pick<NativesClient, 'htmlToMarkdown'> = {
            htmlToMarkdown: (html: string) => `# Title\n\nSome content here.\n\n${html.length} bytes`,
        };

        const result = await extractSiteContent('https://example.com/some-page', mockNatives as NativesClient, signal);

        expect(result).toBeDefined();
        expect(result!.method).toBe('html');
        expect(result!.markdown).toContain('Title');
    });

    it('returns undefined for an invalid URL', async () => {
        const result = await extractSiteContent('not-a-url', undefined, signal);
        expect(result).toBeUndefined();
    });

    it('returns undefined when the registry API returns a non-ok response', async () => {
        globalThis.fetch = ((_url) =>
            Promise.resolve(new Response('not found', { status: 404 }))) as typeof globalThis.fetch;

        const result = await extractSiteContent('https://www.npmjs.com/package/nonexistent', undefined, signal);
        expect(result).toBeUndefined();
    });
});
