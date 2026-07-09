import type { ExternalEditorActionResult, TerminalSuspendActionResult } from '@mission-control/tui/state';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const TERMINAL_TITLE_DISABLE_ENV = 'MCTRL_DISABLE_TERMINAL_TITLE';
export const TERMINAL_TITLE_SET_PREFIX = '\x1b]2;';
export const TERMINAL_TITLE_SET_SUFFIX = '\x07';
export const TERMINAL_TITLE_RESET = '\x1b]2;\x07';

let titleManagementSuppressed = false;

export function suppressTitleManagement(value: boolean): void {
    titleManagementSuppressed = value;
}

export function shouldManageTerminalTitle(): boolean {
    return (
        !titleManagementSuppressed && process.env[TERMINAL_TITLE_DISABLE_ENV] !== '1' && process.stdout.isTTY === true
    );
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

export function formatAppTitle(version: string): string {
    return `Mission Control ${version}`;
}

export function formatSessionTitle(sessionId: string | undefined, sessionDisplayName: string | undefined): string {
    const name = sessionDisplayName !== undefined && sessionDisplayName.length > 0 ? sessionDisplayName : sessionId;
    return name !== undefined && name.length > 0 ? name : formatAppTitle('');
}

export const SUSPEND_UNSUPPORTED_MESSAGE = 'Suspend not supported on Windows.\n';

export const suspendControls = {
    isWindowsPlatform(): boolean {
        return process.platform === 'win32';
    },
    sendSuspendSignal(): void {
        process.kill(process.pid, 'SIGTSTP');
    },
};

export function suspendTerminal(): TerminalSuspendActionResult {
    if (suspendControls.isWindowsPlatform()) {
        return { kind: 'unsupported', message: SUSPEND_UNSUPPORTED_MESSAGE };
    }
    suspendControls.sendSuspendSignal();
    return { kind: 'suspended' };
}

export const NO_EDITOR_MESSAGE = 'No editor set. Set $VISUAL or $EDITOR.\n';
export const VISUAL_ENV = 'VISUAL';
export const EDITOR_ENV = 'EDITOR';

export const editorControls = {
    resolveEditor(): string | undefined {
        return process.env[VISUAL_ENV] ?? process.env[EDITOR_ENV];
    },
    runEditor(editor: string, filePath: string): void {
        spawnSync(editor, [filePath], { stdio: 'inherit' });
    },
};

function formatExternalEditorFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `Editor failed: ${message}\n`;
}

export function openExternalEditor(initialText: string): Promise<ExternalEditorActionResult> {
    const editor = editorControls.resolveEditor();
    if (editor === undefined || editor.length === 0) {
        return Promise.resolve({ kind: 'unavailable', message: NO_EDITOR_MESSAGE });
    }

    const tempPath = join(tmpdir(), `mctrl-edit-${Date.now()}.md`);
    try {
        writeFileSync(tempPath, initialText, 'utf-8');
        editorControls.runEditor(editor, tempPath);
        return Promise.resolve({ kind: 'updated', text: readFileSync(tempPath, 'utf-8') });
    } catch (error: unknown) {
        return Promise.resolve({ kind: 'failed', message: formatExternalEditorFailure(error) });
    } finally {
        rmSync(tempPath, { force: true });
    }
}

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

function runGitRevParse(workspaceRoot: string, args: readonly string[]): string | undefined {
    try {
        const result = spawnSync('git', ['rev-parse', ...args], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1000,
        });
        if (result.error !== undefined || result.status !== 0) {
            return undefined;
        }
        const output = (result.stdout ?? '').trim();
        return output.length > 0 ? output : undefined;
    } catch {
        return undefined;
    }
}

export function detectGitWorktree(workspaceRoot: string | undefined): {
    readonly isWorktree: boolean;
    readonly name: string | undefined;
} {
    if (workspaceRoot === undefined) {
        return { isWorktree: false, name: undefined };
    }
    const gitDir = runGitRevParse(workspaceRoot, ['--git-dir']);
    const commonDir = runGitRevParse(workspaceRoot, ['--git-common-dir']);
    if (gitDir === undefined || commonDir === undefined) {
        return { isWorktree: false, name: undefined };
    }
    if (resolve(workspaceRoot, gitDir) === resolve(workspaceRoot, commonDir)) {
        return { isWorktree: false, name: undefined };
    }
    const topLevel = runGitRevParse(workspaceRoot, ['--show-toplevel']);
    return { isWorktree: true, name: topLevel !== undefined ? basename(topLevel) : undefined };
}
