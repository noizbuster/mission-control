import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Terminal title via OSC 2 (`\x1b]2;<title>\x07`, BEL terminator).
 * Gated on `isTTY` (no escapes to pipes) and `MCTRL_DISABLE_TERMINAL_TITLE !== '1'`.
 */
export const TERMINAL_TITLE_ENABLE_ENV = 'MCTRL_ENABLE_TERMINAL_TITLE';
export const TERMINAL_TITLE_SET_PREFIX = '\x1b]2;';
export const TERMINAL_TITLE_SET_SUFFIX = '\x07';
export const TERMINAL_TITLE_RESET = '\x1b]2;\x07';

export function shouldManageTerminalTitle(): boolean {
    return process.env[TERMINAL_TITLE_ENABLE_ENV] === '1' && process.stdout.isTTY === true;
}

export function setTerminalTitle(title: string): boolean {
    if (!shouldManageTerminalTitle()) {
        return false;
    }
    process.stderr.write(`${TERMINAL_TITLE_SET_PREFIX}${title}${TERMINAL_TITLE_SET_SUFFIX}`);
    return true;
}

export function resetTerminalTitle(): boolean {
    if (!shouldManageTerminalTitle()) {
        return false;
    }
    process.stderr.write(TERMINAL_TITLE_RESET);
    return true;
}

export const SUSPEND_UNSUPPORTED_MESSAGE = 'Suspend not supported on Windows.\n';

/**
 * Suspend signal controls. Exported as an object so unit tests can spy on
 * `isWindowsPlatform` (simulate Windows on a POSIX CI runner) and intercept
 * the real SIGTSTP via `vi.spyOn(process, 'kill')` without actually
 * suspending the test runner.
 */
export const suspendControls = {
    isWindowsPlatform(): boolean {
        return process.platform === 'win32';
    },
    sendSuspendSignal(): void {
        process.kill(process.pid, 'SIGTSTP');
    },
};

export const NO_EDITOR_MESSAGE = 'No editor set. Set $VISUAL or $EDITOR.\n';
export const VISUAL_ENV = 'VISUAL';
export const EDITOR_ENV = 'EDITOR';

/**
 * External editor controls. Exported as an object so unit tests can mock
 * `resolveEditor` (simulate $VISUAL/$EDITOR presence/absence and priority)
 * and `runEditor` (intercept the real `spawnSync` so no editor is launched).
 */
export const editorControls = {
    resolveEditor(): string | undefined {
        return process.env[VISUAL_ENV] ?? process.env[EDITOR_ENV];
    },
    runEditor(editor: string, filePath: string): void {
        spawnSync(editor, [filePath], { stdio: 'inherit' });
    },
};

export const LINUX_CLIPBOARD_IMAGE_COMMANDS = ['xclip -selection clipboard -t image/png -o', 'wl-paste -t image/png'] as const;

/**
 * Clipboard image paste controls. Exported so unit tests can spy on
 * `readClipboardImage` (simulate clipboard with image, without image, or
 * tool absence) without launching real platform clipboard binaries.
 *
 * Platform coverage: Linux X11 (xclip), Linux Wayland (wl-paste), macOS
 * (pngpaste). Windows and unknown platforms return undefined. On failure
 * (tool absent, clipboard has no image), returns undefined silently.
 */
export const clipboardImageControls = {
    readClipboardImage(): { readonly path: string } | undefined {
        const tempPath = join(tmpdir(), `mctrl-paste-${Date.now()}.png`);
        if (process.platform === 'linux') {
            return readLinuxClipboardImage(tempPath);
        }
        if (process.platform === 'darwin') {
            return readMacOSClipboardImage(tempPath);
        }
        return undefined;
    },
};

export function readLinuxClipboardImage(tempPath: string): { readonly path: string } | undefined {
    for (const command of LINUX_CLIPBOARD_IMAGE_COMMANDS) {
        try {
            const buffer = execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] });
            if (buffer.length === 0) {
                return undefined;
            }
            writeFileSync(tempPath, buffer);
            return { path: tempPath };
        } catch {
            // Command not installed or clipboard has no image — try next tool.
        }
    }
    return undefined;
}

export function readMacOSClipboardImage(tempPath: string): { readonly path: string } | undefined {
    try {
        execSync(`pngpaste ${tempPath}`, { stdio: 'ignore' });
        return { path: tempPath };
    } catch {
        return undefined;
    }
}

/**
 * Detect the current git branch of `workspaceRoot` synchronously via `git rev-parse`.
 * Returns undefined when git is unavailable, the workspace is not a git repo,
 * or `HEAD` is detached (the rev-parse returns `HEAD` literally in that case).
 * Exported for unit tests; never throws.
 */
export function detectGitBranch(workspaceRoot: string | undefined): string | undefined {
    if (workspaceRoot === undefined) {
        return undefined;
    }
    try {
        const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1000,
        });
        if (result.error !== undefined || result.status !== 0) {
            return undefined;
        }
        const branch = (result.stdout ?? '').trim();
        if (branch.length === 0 || branch === 'HEAD') {
            return undefined;
        }
        return branch;
    } catch {
        return undefined;
    }
}
