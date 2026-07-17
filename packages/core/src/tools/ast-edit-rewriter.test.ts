import { afterEach, describe, expect, it } from 'vitest';
import { createNativesClient } from '../native/natives-client';
import { createDefaultAstRewriter } from './ast-edit';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
});

describe('createDefaultAstRewriter', () => {
    it('forwards the pattern, files, replacement, and language to the native client', async () => {
        const root = await makeRoot();
        const addonPath = join(root, 'fake-natives.cjs');
        await writeFile(addonPath, fakeAddonSource(), 'utf8');
        const rewriter = createDefaultAstRewriter(createNativesClient({ addonPath, onWarning: () => undefined }));

        const changes = rewriter('console.log($X)', ['/workspace/example.ts'], {
            replacement: 'logger.info($X)',
            lang: 'typescript',
        });

        expect(changes).toEqual([
            {
                path: '/workspace/example.ts',
                before: 'console.log($X)',
                after: 'logger.info($X):typescript',
                byteStart: 0,
                byteEnd: 15,
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 16,
            },
        ]);
    });

    it('fails when the native ast rewrite module is unavailable', async () => {
        const root = await makeRoot();
        const rewriter = createDefaultAstRewriter(
            createNativesClient({ addonPath: join(root, 'missing.node'), onWarning: () => undefined }),
        );

        expect(() =>
            rewriter('console.log($X)', ['/workspace/example.ts'], { replacement: 'logger.info($X)' }),
        ).toThrow('ast module unavailable');
    });
});

async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ast-edit-rewriter-'));
    roots.push(root);
    return root;
}

function fakeAddonSource(): string {
    return `
module.exports = {
    countTokens(text) {
        return text.length;
    },
    astRewrite(pattern, paths, options) {
        return [{
            path: paths[0],
            before: pattern,
            after: options.replacement + ':' + options.lang,
            byteStart: 0,
            byteEnd: 15,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 16,
        }];
    },
};
`;
}
