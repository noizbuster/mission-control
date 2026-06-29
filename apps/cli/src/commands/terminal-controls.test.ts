import { describe, expect, it } from 'vitest';
import { detectGitBranch, detectGitWorktree } from './terminal-controls.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();

/**
 * Real git operations (init / commit / worktree add / submodule add) against
 * temp dirs give true proof of the detection contract. `gitConfig` writes the
 * identity a fresh `git init` needs before it can commit; without it `git
 * commit` refuses to create a commit and `git worktree add` has no HEAD to
 * check out.
 */
function gitConfig(cwd: string): void {
    execSync('git config user.email t@t.test', { cwd });
    execSync('git config user.name mctrl-test', { cwd });
}

function commitOne(cwd: string, filename: string, content: string): void {
    writeFileSync(join(cwd, filename), content);
    execSync(`git add ${filename}`, { cwd });
    execSync('git commit -m init', { cwd, stdio: 'ignore' });
}

describe('terminal-controls — detectGitBranch', () => {
    it('returns the current branch of this repo (regression guard for the newly-wired call)', () => {
        const expected = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
        const detected = detectGitBranch(repoRoot);
        if (expected === 'HEAD') {
            // Detached HEAD: detectGitBranch returns undefined by contract.
            expect(detected).toBeUndefined();
        } else {
            expect(detected).toBe(expected);
        }
    });

    it('returns undefined for an undefined workspaceRoot without throwing', () => {
        expect(detectGitBranch(undefined)).toBeUndefined();
    });

    it('returns undefined for a non-git directory without throwing', () => {
        const nonGit = mkdtempSync(join(tmpdir(), 'mctrl-no-git-'));
        try {
            expect(detectGitBranch(nonGit)).toBeUndefined();
        } finally {
            rmSync(nonGit, { recursive: true, force: true });
        }
    });
});

describe('terminal-controls — detectGitWorktree', () => {
    it('returns { isWorktree: false, name: undefined } for an undefined workspaceRoot without throwing', () => {
        expect(detectGitWorktree(undefined)).toEqual({ isWorktree: false, name: undefined });
    });

    it('returns { isWorktree: false, name: undefined } for a non-git directory without throwing', () => {
        const nonGit = mkdtempSync(join(tmpdir(), 'mctrl-wt-non-git-'));
        try {
            expect(detectGitWorktree(nonGit)).toEqual({ isWorktree: false, name: undefined });
        } finally {
            rmSync(nonGit, { recursive: true, force: true });
        }
    });

    it('returns { isWorktree: false, name: undefined } for the main checkout of this repo', () => {
        // Given: this repo is a main checkout (git-dir == git-common-dir).
        // When: detecting the worktree status.
        // Then: it is NOT reported as a linked worktree.
        expect(detectGitWorktree(repoRoot)).toEqual({ isWorktree: false, name: undefined });
    });

    it('returns { isWorktree: false, name: undefined } for a main checkout with a fresh commit', () => {
        const main = mkdtempSync(join(tmpdir(), 'mctrl-wt-main-'));
        try {
            execSync('git init', { cwd: main, stdio: 'ignore' });
            gitConfig(main);
            commitOne(main, 'file.txt', 'x');
            // Given: a normal main checkout.
            // Then: not a worktree.
            expect(detectGitWorktree(main)).toEqual({ isWorktree: false, name: undefined });
        } finally {
            rmSync(main, { recursive: true, force: true });
        }
    });

    it('does NOT false-positive on a git submodule (the .git-file trap)', () => {
        const parent = mkdtempSync(join(tmpdir(), 'mctrl-wt-submod-parent-'));
        const subSource = mkdtempSync(join(tmpdir(), 'mctrl-wt-submod-src-'));
        try {
            // Parent repo with one commit (submodule add needs a commit).
            execSync('git init', { cwd: parent, stdio: 'ignore' });
            gitConfig(parent);
            commitOne(parent, 'root.txt', 'x');

            // The future submodule: its own repo with a commit.
            execSync('git init', { cwd: subSource, stdio: 'ignore' });
            gitConfig(subSource);
            commitOne(subSource, 's.txt', 'x');

            // `protocol.file.allow=always` opts into the file transport that git
            // blocks by default since CVE-2022-39253; required to clone a local
            // path as a submodule.
            execSync(`git -c protocol.file.allow=always -C ${parent} submodule add ${subSource} sub`, {
                stdio: 'ignore',
            });
            const subWorkingDir = join(parent, 'sub');

            // Given: `subWorkingDir` is a submodule — its `.git` is a FILE (a
            // gitfile pointer), which would fool a naive file-vs-dir heuristic.
            // Then: git-dir and git-common-dir are identical (the submodule's
            // own git dir IS its common dir), so it must NOT be flagged as a
            // linked worktree.
            expect(detectGitWorktree(subWorkingDir)).toEqual({ isWorktree: false, name: undefined });
        } finally {
            rmSync(parent, { recursive: true, force: true });
            rmSync(subSource, { recursive: true, force: true });
        }
    });

    it('detects a real linked worktree created via `git worktree add`', () => {
        const main = mkdtempSync(join(tmpdir(), 'mctrl-wt-real-main-'));
        try {
            execSync('git init', { cwd: main, stdio: 'ignore' });
            gitConfig(main);
            commitOne(main, 'file.txt', 'x');

            const worktreeDir = join(main, 'linked-wt');
            execSync(`git -C ${main} worktree add ${worktreeDir}`, { stdio: 'ignore' });

            // Given: `worktreeDir` is a linked worktree; --git-dir resolves to
            // <main>/.git/worktrees/linked-wt while --git-common-dir resolves to
            // the shared <main>/.git.
            // Then: isWorktree is true and name is the worktree dir basename.
            const result = detectGitWorktree(worktreeDir);
            expect(result.isWorktree).toBe(true);
            expect(result.name).toBe('linked-wt');
        } finally {
            // `git worktree add` registers the worktree under <main>/.git; remove
            // the registration before rmSync so git doesn't complain on the
            // recursive delete of the temp tree.
            try {
                execSync(`git -C ${main} worktree remove --force linked-wt`, { stdio: 'ignore' });
            } catch {
                // ignore — best-effort cleanup
            }
            rmSync(main, { recursive: true, force: true });
        }
    });
});
