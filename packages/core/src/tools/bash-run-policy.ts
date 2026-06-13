import { parseTrustedCommandLine } from './bash-run-command-guard.js';
import { commandRunFailure } from './command-run-errors.js';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const defaultBashRunTimeoutMs = 30_000;

export const defaultBashEnvAllowlist = [
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TEMP',
    'TERM',
    'TMP',
    'TMPDIR',
    'USER',
    'USERNAME',
] as const;

const secretEnvKeyPattern = /(AUTH|COOKIE|KEY|PASS|SECRET|TOKEN)/i;
export function assertTrustedWorkspace(workspaceTrust: 'trusted' | 'denied' | 'unknown'): void {
    if (workspaceTrust === 'trusted') {
        return;
    }
    throw commandRunFailure(
        'command_not_allowed',
        `trusted bash requires a trusted workspace, current trust is ${workspaceTrust}`,
    );
}

export function assertAllowedCommandLine(commandLine: string): readonly string[] {
    return parseTrustedCommandLine(commandLine);
}

export async function resolveBashCwd(workspaceRoot: string, requestedCwd?: string): Promise<string> {
    const candidate = requestedCwd === undefined ? workspaceRoot : resolveRequestedCwd(workspaceRoot, requestedCwd);
    let normalized: string;
    try {
        normalized = await realpath(candidate);
    } catch (error: unknown) {
        throw commandRunFailure(
            'command_not_allowed',
            `cwd must resolve to an existing workspace directory: ${errorMessage(error)}`,
        );
    }
    const directory = await stat(normalized).catch((error: unknown) => {
        throw commandRunFailure(
            'command_not_allowed',
            `cwd must resolve to an existing workspace directory: ${errorMessage(error)}`,
        );
    });
    if (!directory.isDirectory()) {
        throw commandRunFailure('command_not_allowed', `cwd is not a directory: ${requestedCwd ?? workspaceRoot}`);
    }
    const relation = relative(workspaceRoot, normalized);
    if (relation.startsWith('..') || relation === '' ? false : isAbsolute(relation)) {
        throw commandRunFailure('command_not_allowed', `cwd escapes the workspace: ${requestedCwd ?? normalized}`);
    }
    if (relation === '..' || relation.startsWith(`..${pathSeparator()}`)) {
        throw commandRunFailure('command_not_allowed', `cwd escapes the workspace: ${requestedCwd ?? normalized}`);
    }
    return normalized;
}

export function buildTrustedBashEnv(
    hostEnv: NodeJS.ProcessEnv,
    allowlist: readonly string[],
): { readonly env: NodeJS.ProcessEnv; readonly redactionSecrets: readonly string[] } {
    const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', TERM: 'dumb' };
    const forceColorKey = 'FORCE_COLOR';
    for (const key of allowlist) {
        const value = hostEnv[key];
        if (typeof value === 'string' && value.length > 0) {
            env[key] = value;
        }
    }
    delete env[forceColorKey];
    const redactionSecrets = Object.entries(env)
        .filter(([key, value]) => secretEnvKeyPattern.test(key) && typeof value === 'string' && value.length > 0)
        .map(([, value]) => value as string);
    return { env, redactionSecrets };
}

function resolveRequestedCwd(workspaceRoot: string, requestedCwd: string): string {
    return isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(workspaceRoot, requestedCwd);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function pathSeparator(): string {
    return process.platform === 'win32' ? '\\' : '/';
}
