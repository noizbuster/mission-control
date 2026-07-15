import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    changedTypeScriptSizeViolations,
    countPureLoc,
    formatChangedTypeScriptSizeReport,
    hasAttributedSizeOk,
    inspectChangedTypeScript,
    parseChangedTypeScriptBaseArgument,
} from '../scripts/changed-typescript-size';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const repositories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository, { recursive: true, force: true })));
});

describe('changed TypeScript size release gate', () => {
    it('counts only nonblank, non-line-comment source lines', () => {
        const source = ['const first = 1;', '', '  // note', '# shell note', '-- sql note', 'const second = 2;'].join(
            '\n',
        );

        expect(countPureLoc(source)).toBe(2);
    });

    it('requires SIZE_OK to carry HEAD/current attribution and a specific reason', () => {
        expect(
            hasAttributedSizeOk(
                '// allow: SIZE_OK - HEAD 300 -> current 302 pure LOC; one cohesive lease state machine whose transitions share the same epoch invariants.',
                302,
            ),
        ).toBe(true);
        expect(
            hasAttributedSizeOk(
                '// allow: SIZE_OK -- HEAD 300 -> current 302 pure LOC; one cohesive lease state machine whose transitions share the same epoch invariants.',
                302,
            ),
        ).toBe(true);
        expect(hasAttributedSizeOk('// allow: SIZE_OK - legacy file', 302)).toBe(false);
        expect(
            hasAttributedSizeOk(
                '// allow: SIZE_OK - HEAD 300 -> current 302 pure LOC; one cohesive lease state machine whose transitions share the same epoch invariants.',
                303,
            ),
        ).toBe(false);
    });

    it.each([
        ['string literal', (marker: string) => `const stringValue = '${marker}';`],
        ['template literal', (marker: string) => `const templateValue = \`${marker}\`;`],
        [
            'identifier label',
            () => 'allow: SIZE_OK; // HEAD 300 -> current 302 pure LOC; this executable label is not authorization.',
        ],
        ['regular expression literal', (marker: string) => `const regexValue = /${marker.replaceAll('/', '\\/')}/u;`],
        [
            'unrelated comment',
            () =>
                '// unrelated note: allow: SIZE_OK -- HEAD 300 -> current 302 pure LOC; this reason is not an authorization.',
        ],
    ] as const)('ignores marker-shaped %s', (_kind, createSource) => {
        const validMarker =
            '// allow: SIZE_OK -- HEAD 300 -> current 302 pure LOC; one cohesive lease state machine whose transitions share the same epoch invariants.';

        expect(hasAttributedSizeOk(createSource(validMarker), 302)).toBe(false);
    });

    it('reports no unapproved changed-file overages', () => {
        const records = inspectChangedTypeScript(root, gitLine(root, ['rev-parse', 'HEAD']));
        const report = formatChangedTypeScriptSizeReport(records);

        expect(changedTypeScriptSizeViolations(records), report).toEqual([]);
        expect(report).toBe('changed TypeScript size gate: 0 unapproved overages');
    });

    it('uses a pull request base SHA through the merge base', async () => {
        // Given: the PR base advanced after the feature branch split.
        const repository = await createRepository('pr-base');
        await writeFile(join(repository, 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
        commitAll(repository, 'baseline');
        git(repository, ['branch', 'feature']);
        await writeFile(join(repository, 'base-only.ts'), 'export const baseOnly = true;\n', 'utf8');
        commitAll(repository, 'advance base');
        const pullRequestBase = gitLine(repository, ['rev-parse', 'HEAD']);
        git(repository, ['checkout', 'feature']);
        await writeOversizedTypeScript(repository);
        commitAll(repository, 'feature change');

        // When: the gate compares the feature head to the explicit PR base.
        const violations = changedTypeScriptSizeViolations(inspectChangedTypeScript(repository, pullRequestBase));

        // Then: the committed feature file is audited from the true branch point.
        expect(violations).toMatchObject([{ file: 'oversized.ts', pureLoc: 251, exempt: false }]);
    });

    it('audits a clean committed push diff against its before SHA', async () => {
        // Given: a clean checkout whose pushed commit introduces an oversized TypeScript file.
        const repository = await createRepository('push-base');
        await writeFile(join(repository, 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
        commitAll(repository, 'baseline');
        const pushBase = gitLine(repository, ['rev-parse', 'HEAD']);
        await writeOversizedTypeScript(repository);
        commitAll(repository, 'violating push');

        // When: the gate receives the push event's before SHA.
        const violations = changedTypeScriptSizeViolations(inspectChangedTypeScript(repository, pushBase));

        // Then: committed files remain visible even with no working-tree changes.
        expect(violations).toMatchObject([{ file: 'oversized.ts', pureLoc: 251, exempt: false }]);
    });

    it('accepts a validated base SHA from the environment', async () => {
        // Given: a pushed commit and its before SHA in the CI environment.
        const repository = await createRepository('environment-base');
        await writeFile(join(repository, 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
        commitAll(repository, 'baseline');
        vi.stubEnv('MCTRL_CHANGED_TS_BASE', gitLine(repository, ['rev-parse', 'HEAD']));
        await writeOversizedTypeScript(repository);
        commitAll(repository, 'environment push');

        // When: the gate runs without a function argument.
        const violations = changedTypeScriptSizeViolations(inspectChangedTypeScript(repository));

        // Then: the committed CI diff is audited instead of defaulting to HEAD.
        expect(violations).toMatchObject([{ file: 'oversized.ts', pureLoc: 251, exempt: false }]);
    });

    it('defaults local runs to HEAD plus uncommitted work', async () => {
        // Given: HEAD is clean and an oversized file exists only in the working tree.
        const repository = await createRepository('local-worktree');
        await writeFile(join(repository, 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
        commitAll(repository, 'baseline');
        await writeOversizedTypeScript(repository);

        // When: no CI base is supplied.
        const violations = changedTypeScriptSizeViolations(inspectChangedTypeScript(repository));

        // Then: local uncommitted work is audited against HEAD.
        expect(violations).toMatchObject([{ file: 'oversized.ts', pureLoc: 251, exempt: false }]);
    });

    it('audits changed TypeScript filenames containing newlines', async () => {
        // Given: a clean repository and an untracked oversized TypeScript path containing a newline.
        const repository = await createRepository('newline-path');
        await writeFile(join(repository, 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
        commitAll(repository, 'baseline');
        const file = 'line\nbreak.ts';
        await writeOversizedTypeScript(repository, file);

        // When: the local gate discovers NUL-delimited Git paths.
        const violations = changedTypeScriptSizeViolations(inspectChangedTypeScript(repository));

        // Then: the hostile-but-valid path is audited without quoting loss.
        expect(violations).toMatchObject([{ file, pureLoc: 251, exempt: false }]);
    });

    it('does not follow changed TypeScript symlinks', async () => {
        // Given: an untracked TypeScript symlink targets a non-TypeScript file.
        const repository = await createRepository('symlink-path');
        await writeFile(join(repository, 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
        commitAll(repository, 'baseline');
        await writeFile(join(repository, 'outside.txt'), 'export const followed = true;\n', 'utf8');
        await symlink('outside.txt', join(repository, 'linked.ts'));

        // When: the local gate inspects changed paths.
        const records = inspectChangedTypeScript(repository);

        // Then: it rejects the symlink instead of following its target.
        expect(records).toEqual([]);
    });

    it('falls back safely from an all-zero initial-push base', async () => {
        // Given: the pushed head has a valid parent and an oversized committed diff.
        const repository = await createRepository('initial-push');
        await writeFile(join(repository, 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
        commitAll(repository, 'baseline');
        await writeOversizedTypeScript(repository);
        commitAll(repository, 'initial push head');

        // When: GitHub supplies its all-zero sentinel instead of a base commit.
        const violations = changedTypeScriptSizeViolations(inspectChangedTypeScript(repository, '0'.repeat(40)));

        // Then: the valid HEAD parent is used and the pushed commit remains audited.
        expect(violations).toMatchObject([{ file: 'oversized.ts', pureLoc: 251, exempt: false }]);
    });

    it('compares an all-zero root-commit push against the empty tree', async () => {
        // Given: the pushed head is the repository root commit with no parent.
        const repository = await createRepository('root-push');
        await writeOversizedTypeScript(repository);
        commitAll(repository, 'root push');

        // When: GitHub supplies its all-zero sentinel for the initial push.
        const violations = changedTypeScriptSizeViolations(inspectChangedTypeScript(repository, '0'.repeat(40)));

        // Then: the empty tree is used and the root commit remains audited.
        expect(violations).toMatchObject([{ file: 'oversized.ts', pureLoc: 251, exempt: false }]);
    });

    it('rejects an invalid explicit base SHA', async () => {
        const repository = await createRepository('invalid-base');
        await writeFile(join(repository, 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
        commitAll(repository, 'baseline');

        expect(() => inspectChangedTypeScript(repository, 'not-a-commit')).toThrow(
            /invalid changed TypeScript base SHA/iu,
        );
    });

    it('accepts the explicit --base argument forms and rejects ambiguous input', () => {
        const sha = 'a'.repeat(40);

        expect(parseChangedTypeScriptBaseArgument(['--base', sha])).toBe(sha);
        expect(parseChangedTypeScriptBaseArgument([`--base=${sha}`])).toBe(sha);
        expect(parseChangedTypeScriptBaseArgument(['--', '--base', sha])).toBe(sha);
        expect(parseChangedTypeScriptBaseArgument([])).toBeUndefined();
        expect(() => parseChangedTypeScriptBaseArgument(['--base'])).toThrow(/usage/iu);
        expect(() => parseChangedTypeScriptBaseArgument([sha])).toThrow(/usage/iu);
    });
});

async function createRepository(name: string): Promise<string> {
    const repository = await mkdtemp(join(tmpdir(), `mctrl-size-${name}-`));
    repositories.push(repository);
    git(repository, ['init', '--initial-branch=main']);
    return repository;
}

async function writeOversizedTypeScript(repository: string, file = 'oversized.ts'): Promise<void> {
    const source = Array.from({ length: 251 }, (_, index) => `export const line${index} = ${index};`).join('\n');
    await writeFile(join(repository, file), `${source}\n`, 'utf8');
}

function commitAll(repository: string, message: string): void {
    git(repository, ['add', '.']);
    git(repository, [
        '-c',
        'user.name=Mission Control Tests',
        '-c',
        'user.email=tests@example.invalid',
        'commit',
        '-m',
        message,
    ]);
}

function git(repository: string, args: readonly string[]): void {
    execFileSync('git', args, { cwd: repository, stdio: 'ignore' });
}

function gitLine(repository: string, args: readonly string[]): string {
    return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}
