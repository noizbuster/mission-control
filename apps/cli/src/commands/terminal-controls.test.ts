import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTtyState } from './run-agent-chat-test-support.js';
import {
    detectGitBranch,
    detectGitWorktree,
    editorControls,
    formatAppTitle,
    formatSessionTitle,
    NO_EDITOR_MESSAGE,
    openExternalEditor,
    resetTerminalTitle,
    SUSPEND_UNSUPPORTED_MESSAGE,
    setTerminalTitle,
    shouldManageTerminalTitle,
    suppressTitleManagement,
    suspendControls,
    suspendTerminal,
    TERMINAL_TITLE_DISABLE_ENV,
    TERMINAL_TITLE_RESET,
    TERMINAL_TITLE_SET_PREFIX,
    TERMINAL_TITLE_SET_SUFFIX,
} from './terminal-controls.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const repoRoot = process.cwd();

afterEach(() => {
    suppressTitleManagement(false);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

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

    it('returns the actual worktree status for the current checkout', () => {
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        const commonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim();
        const topLevel = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
        const isWorktree = resolve(repoRoot, gitDir) !== resolve(repoRoot, commonDir);

        expect(detectGitWorktree(repoRoot)).toEqual({
            isWorktree,
            name: isWorktree ? basename(topLevel) : undefined,
        });
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

describe('terminal-controls — title formatters', () => {
    it('formatAppTitle embeds the version after the product name', () => {
        expect(formatAppTitle('0.1.0')).toBe('Mission Control 0.1.0');
    });

    it('formatSessionTitle prefers the display name when set', () => {
        expect(formatSessionTitle('session_abc', 'my session')).toBe('my session');
    });

    it('formatSessionTitle falls back to the session id when the display name is empty', () => {
        expect(formatSessionTitle('session_abc', '')).toBe('session_abc');
        expect(formatSessionTitle('session_abc', undefined)).toBe('session_abc');
    });

    it('formatSessionTitle falls back to the app title when neither id nor name is present', () => {
        expect(formatSessionTitle(undefined, undefined)).toBe('Mission Control ');
    });
});

describe('terminal-controls — title management gates', () => {
    it('writes OSC title escapes when stdout is TTY and title management is enabled', () => {
        const restoreTtyState = setTtyState({ input: true, output: true });
        try {
            suppressTitleManagement(false);

            const { result, stderr } = captureStderr(() => ({
                set: setTerminalTitle('TUI title'),
                reset: resetTerminalTitle(),
            }));

            expect(shouldManageTerminalTitle()).toBe(true);
            expect(result).toEqual({ set: true, reset: true });
            expect(stderr).toBe(
                `${TERMINAL_TITLE_SET_PREFIX}TUI title${TERMINAL_TITLE_SET_SUFFIX}${TERMINAL_TITLE_RESET}`,
            );
        } finally {
            restoreTtyState();
        }
    });

    it('suppresses OSC title escapes when stdout is not TTY', () => {
        const restoreTtyState = setTtyState({ input: true, output: false });
        try {
            const { result, stderr } = captureStderr(() => setTerminalTitle('hidden'));

            expect(shouldManageTerminalTitle()).toBe(false);
            expect(result).toBe(false);
            expect(stderr).toBe('');
        } finally {
            restoreTtyState();
        }
    });

    it('suppresses OSC title escapes when MCTRL_DISABLE_TERMINAL_TITLE is set', () => {
        const restoreTtyState = setTtyState({ input: true, output: true });
        vi.stubEnv(TERMINAL_TITLE_DISABLE_ENV, '1');
        try {
            const { result, stderr } = captureStderr(() => setTerminalTitle('hidden'));

            expect(shouldManageTerminalTitle()).toBe(false);
            expect(result).toBe(false);
            expect(stderr).toBe('');
        } finally {
            restoreTtyState();
        }
    });

    it('suppresses OSC title escapes when title management is explicitly suppressed', () => {
        const restoreTtyState = setTtyState({ input: true, output: true });
        try {
            suppressTitleManagement(true);
            const { result, stderr } = captureStderr(() => setTerminalTitle('hidden'));

            expect(shouldManageTerminalTitle()).toBe(false);
            expect(result).toBe(false);
            expect(stderr).toBe('');
        } finally {
            restoreTtyState();
        }
    });
});

describe('terminal-controls — suspend action', () => {
    it('returns unsupported on Windows without sending SIGTSTP', () => {
        vi.spyOn(suspendControls, 'isWindowsPlatform').mockReturnValue(true);
        const sendSuspendSignal = vi.spyOn(suspendControls, 'sendSuspendSignal').mockImplementation(() => {});

        expect(suspendTerminal()).toEqual({ kind: 'unsupported', message: SUSPEND_UNSUPPORTED_MESSAGE });
        expect(sendSuspendSignal).not.toHaveBeenCalled();
    });

    it('sends SIGTSTP on POSIX platforms', () => {
        vi.spyOn(suspendControls, 'isWindowsPlatform').mockReturnValue(false);
        const sendSuspendSignal = vi.spyOn(suspendControls, 'sendSuspendSignal').mockImplementation(() => {});

        expect(suspendTerminal()).toEqual({ kind: 'suspended' });
        expect(sendSuspendSignal).toHaveBeenCalledOnce();
    });
});

describe('terminal-controls — external editor action', () => {
    it('returns unavailable when neither VISUAL nor EDITOR resolves', async () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue(undefined);

        await expect(openExternalEditor('draft')).resolves.toEqual({ kind: 'unavailable', message: NO_EDITOR_MESSAGE });
    });

    it('returns the edited prompt text from the temporary file', async () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('fake-editor');
        vi.spyOn(editorControls, 'runEditor').mockImplementation((_editor, filePath) => {
            writeFileSync(filePath, 'edited draft');
        });

        await expect(openExternalEditor('draft')).resolves.toEqual({ kind: 'updated', text: 'edited draft' });
    });
});

function captureStderr<T>(fn: () => T): { readonly result: T; readonly stderr: string } {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data: unknown) => {
        writes.push(typeof data === 'string' ? data : String(data));
        return true;
    });
    try {
        const result = fn();
        return { result, stderr: writes.join('') };
    } finally {
        spy.mockRestore();
    }
}
