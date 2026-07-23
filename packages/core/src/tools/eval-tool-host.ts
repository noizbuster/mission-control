import {
    createWorkspaceGuard,
    directDependencySourcePaths,
    matchesWorkspaceDenylist,
    type WorkspaceGuard,
} from './read-tools-paths';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const BRIDGE_READ_CAP_BYTES = 256 * 1024;

export function createEvalToolHost(workspaceRoot: string): (name: string, args: unknown) => Promise<unknown> {
    let workspaceGuard: Promise<WorkspaceGuard> | undefined;
    return async (name, args) => {
        workspaceGuard ??= createWorkspaceGuard(workspaceRoot, {
            allowDirectDenylistedPaths: directDependencySourcePaths,
        });
        const guard = await workspaceGuard;
        const argRecord = isRecord(args) ? args : {};
        switch (name) {
            case 'read':
            case 'repo.read':
                return readWorkspaceFile(guard, stringField(argRecord, 'path'));
            case 'ls':
            case 'repo.list':
                return listWorkspaceDir(guard, stringField(argRecord, 'path'));
            case 'grep':
            case 'search':
            case 'repo.search':
                return searchWorkspaceText(guard, stringField(argRecord, 'pattern'), argRecord);
            case 'find':
            case 'glob':
                return findWorkspaceGlob(guard, stringField(argRecord, 'pattern'));
            default:
                throw new Error(`eval bridge does not implement tool: ${name}`);
        }
    };
}

async function resolveContained(guard: WorkspaceGuard, requestedPath: string): Promise<string> {
    if (requestedPath.length === 0) {
        throw new Error('eval bridge: path is required');
    }
    return (await guard.resolveExisting(requestedPath)).absolutePath;
}

async function readWorkspaceFile(guard: WorkspaceGuard, requestedPath: string): Promise<string> {
    const absolute = await resolveContained(guard, requestedPath);
    const content = await readFile(absolute, 'utf8');
    if (content.length > BRIDGE_READ_CAP_BYTES) {
        return content.slice(0, BRIDGE_READ_CAP_BYTES);
    }
    return content;
}

async function listWorkspaceDir(guard: WorkspaceGuard, requestedPath: string): Promise<readonly string[]> {
    const absolute = await resolveContained(guard, requestedPath.length === 0 ? '.' : requestedPath);
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
}

async function searchWorkspaceText(
    guard: WorkspaceGuard,
    pattern: string,
    argRecord: Record<string, unknown>,
): Promise<readonly { readonly path: string; readonly line: string }[]> {
    if (pattern.length === 0) {
        return [];
    }
    const path = stringField(argRecord, 'path');
    const target = await guard.resolveExisting(path.length === 0 ? '.' : path);
    if (target.stats.isFile()) {
        return searchInFile(target.relativePath, target.absolutePath, pattern);
    }
    return [];
}

async function searchInFile(
    relativePath: string,
    absolute: string,
    pattern: string,
): Promise<readonly { readonly path: string; readonly line: string }[]> {
    const content = await readFile(absolute, 'utf8');
    const matches: { readonly path: string; readonly line: string }[] = [];
    for (const line of content.split('\n')) {
        if (line.includes(pattern)) {
            matches.push({ path: relativePath, line });
            if (matches.length >= 50) {
                break;
            }
        }
    }
    return matches;
}

async function findWorkspaceGlob(guard: WorkspaceGuard, pattern: string): Promise<readonly string[]> {
    const effectivePattern = pattern.length === 0 ? '**/*' : pattern;
    const regex = globToRegExp(effectivePattern);
    const results: string[] = [];
    await walk(guard.root, guard.root, regex, results, 0);
    return results;
}

async function walk(root: string, current: string, regex: RegExp, results: string[], depth: number): Promise<void> {
    if (depth > 12 || results.length >= 200) {
        return;
    }
    let entries: Dirent[];
    try {
        entries = await readdir(current, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const rel = relative(root, resolve(current, entry.name));
        if (rel !== '' && matchesWorkspaceDenylist(rel)) {
            continue;
        }
        const full = entry.isDirectory() ? `${rel}/` : rel;
        if (regex.test(rel) || regex.test(full)) {
            results.push(rel);
        }
        if (entry.isDirectory()) {
            await walk(root, resolve(current, entry.name), regex, results, depth + 1);
        }
    }
}

function globToRegExp(pattern: string): RegExp {
    let expression = '';
    for (const char of pattern) {
        if (char === '*') {
            expression += '[^/]*';
        } else if (char === '?') {
            expression += '[^/]';
        } else if (('.+^$' + '{}()|[]\\').includes(char)) {
            expression += `\\${char}`;
        } else {
            expression += char;
        }
    }
    return new RegExp(`^${expression}$`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
