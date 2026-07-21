/**
 * Resolve which search backend the `ripgrep` tool should drive.
 *
 * 1. `rg` (preferred)  — fastest, full regex, native JSON output.
 * 2. `grep` (fallback) — ubiquitous on POSIX; ERE mode covers most patterns.
 * 3. `node` (last)     — pure-JS regex via `RegExp`; always available.
 *
 * The resolved CLI is cached for the process. If a runtime spawn fails for the
 * resolved backend (e.g. the binary was removed mid-run), callers should fall
 * through to the next tier manually via `reresolveSearchCliSkipping(backend)`.
 *
 * Ported from `ref/omo/packages/omo-opencode/src/shared/ripgrep-cli.ts`, minus
 * the auto-download tier (mc has no precedent for auto-installing binaries).
 */
import { spawnSync } from 'node:child_process';

export type SearchBackend = 'rg' | 'grep' | 'node';

export type ResolvedSearchCli =
    | { readonly backend: 'rg'; readonly path: string }
    | { readonly backend: 'grep'; readonly path: string }
    | { readonly backend: 'node'; readonly path: null };

let cachedCli: ResolvedSearchCli | null = null;
const skippedBackends: Set<SearchBackend> = new Set();

export function resolveSearchCli(): ResolvedSearchCli {
    if (cachedCli !== null) {
        return cachedCli;
    }
    if (!skippedBackends.has('rg')) {
        const rgPath = findExecutable('rg');
        if (rgPath !== null) {
            cachedCli = { backend: 'rg', path: rgPath };
            return cachedCli;
        }
    }
    if (!skippedBackends.has('grep')) {
        const grepPath = findExecutable('grep');
        if (grepPath !== null) {
            cachedCli = { backend: 'grep', path: grepPath };
            return cachedCli;
        }
    }
    cachedCli = { backend: 'node', path: null };
    return cachedCli;
}

/**
 * Drop the resolved cache and mark `backend` as skipped on subsequent resolves.
 * Call this from a spawn error handler when the cached backend fails at runtime
 * (e.g. ENOENT) so the next `resolveSearchCli()` falls through to the next tier.
 *
 * Resets once every backend is skipped — at that point the resolver returns
 * `node` unconditionally (which always works).
 */
export function reresolveSearchCliSkipping(backend: SearchBackend): ResolvedSearchCli {
    cachedCli = null;
    skippedBackends.add(backend);
    if (skippedBackends.size >= 3) {
        skippedBackends.clear();
    }
    return resolveSearchCli();
}

/** Test-only: clear caches so the next `resolveSearchCli()` re-probes PATH. */
export function resetSearchCliCacheForTests(): void {
    cachedCli = null;
    skippedBackends.clear();
}

function findExecutable(name: string): string | null {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where.exe' : 'which';
    try {
        const result = spawnSync(cmd, [name], {
            encoding: 'utf-8',
            timeout: 5000,
            windowsHide: isWindows,
            shell: false,
        });
        if (result.status === 0 && result.stdout.trim().length > 0) {
            return firstExecutablePath(result.stdout);
        }
    } catch {
        return null;
    }
    return null;
}

function firstExecutablePath(stdout: string): string | null {
    const line = stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
    return line ?? null;
}
