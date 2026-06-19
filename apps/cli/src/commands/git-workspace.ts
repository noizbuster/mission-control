import { spawn } from 'node:child_process';

/**
 * Resolve whether `directory` is inside a git work tree. Uses `git rev-parse --is-inside-work-tree`
 * so it works inside subdirectories of a repository. Returns `false` on every error (git missing,
 * not a work tree, spawn failure) — never throws, so it is safe to call when wiring the
 * system-prompt environment block.
 */
export async function isGitWorkspace(directory: string): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd: directory,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.once('error', () => resolve(false));
        child.once('close', (code) => {
            resolve(code === 0 && stdout.trim() === 'true');
        });
    });
}
