/**
 * Canonical atomic file-write helper (temp-file-then-rename).
 *
 * AGENTS.md mandates atomic temp-file-then-rename writes for `.mc/` persistence.
 * Previously each store reimplemented this inline, and five of those copies had a
 * real temp-file-leak bug: they did `writeFile → rename → rm` with NO `try/finally`,
 * so a throwing `rename` skipped the cleanup `rm` and orphaned a `.tmp` file on
 * disk. This module owns the single correct implementation (always cleans up via
 * `try/finally`) plus the shared options the variants need: an optional `mode`
 * (chmod temp before rename and target after — used for credential files) and a
 * `beforeCommit` hook (used by the permission store to observe the staged temp
 * file before the rename becomes visible).
 *
 * `tui-stores/store-file-io.ts` re-exports {@link atomicWriteTextFile} for back-compat.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type AtomicWriteFileOptions = {
    /**
     * When set, the temp file is chmod'd to this mode after writing and the target
     * is chmod'd to this mode after the rename. Used to harden credential files
     * (e.g. `0o600`).
     */
    readonly mode?: number;
    /**
     * Hook invoked after the temp file is fully written but before it is renamed
     * into place. Used by the permission store to observe the staged file before
     * the rename makes it visible.
     */
    readonly beforeCommit?: () => Promise<void> | void;
};

/**
 * Atomically write `contents` to `filePath` via a temp file + rename. Always
 * removes the temp file on success or failure (the bug fixed vs. the inline copies).
 */
export async function atomicWriteFile(
    filePath: string,
    contents: string,
    options: AtomicWriteFileOptions = {},
): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    try {
        await writeFile(tempPath, contents, {
            encoding: 'utf8',
            flag: 'wx',
            ...(options.mode !== undefined ? { mode: options.mode } : {}),
        });
        if (options.mode !== undefined) {
            await chmod(tempPath, options.mode);
        }
        await options.beforeCommit?.();
        await rename(tempPath, filePath);
    } finally {
        await rm(tempPath, { force: true });
    }
    if (options.mode !== undefined) {
        await chmod(filePath, options.mode);
    }
}

/** Shorthand for {@link atomicWriteFile} with no options. */
export async function atomicWriteTextFile(filePath: string, contents: string): Promise<void> {
    await atomicWriteFile(filePath, contents);
}

/** Atomically write a JSON value pretty-printed with a trailing newline. */
export async function atomicWriteJsonFile(filePath: string, value: unknown): Promise<void> {
    await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
