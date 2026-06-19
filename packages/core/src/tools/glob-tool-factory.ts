/**
 * Workspace-scoped `glob` factory.
 *
 * The static `globToolRegistration` resolves its base via `process.cwd()` / absolute paths and
 * `readdir`-walks with no workspace guard and no `temp/ref-repos` deny. Registering it bare would
 * expose an unguarded filesystem walk (escape outside the workspace, into reference repos). This
 * factory mirrors `createReadOnlyRepoToolRegistrations` + the read-tools guard: it pins the base
 * to the workspace root, rejects absolute and symlink-escape targets, applies the SAME denylist
 * the read tools use, and stays read-class. The tool name stays `glob`.
 */
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import {
    formatGlobModelOutput,
    type GlobToolInput,
    type GlobToolOutput,
    globInputSchema,
    globOutputLimit,
    globOutputSchema,
    globParametersJsonSchema,
    globToRegExp,
    safeReaddirRecursive,
} from './glob-tool.js';
import { repoToolFailure } from './read-tools-errors.js';
import { createWorkspaceGuard, type WorkspaceGuard } from './read-tools-paths.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type GlobToolFactoryOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission?: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
};

export async function registerGlobTool(
    registry: ToolRegistry,
    options: GlobToolFactoryOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createGlobToolRegistration(options));
}

export async function createGlobToolRegistration(
    options: GlobToolFactoryOptions,
): Promise<ToolRegistration<GlobToolInput, GlobToolOutput>> {
    const guard = await createWorkspaceGuard(options.workspaceRoot);
    return {
        name: 'glob',
        description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/*.json") under the workspace.',
        capabilityClasses: ['read'],
        parametersJsonSchema: globParametersJsonSchema,
        inputSchema: globInputSchema,
        outputSchema: globOutputSchema,
        outputLimit: globOutputLimit,
        guideline:
            'Use glob to discover files before reading. Bases are workspace-relative; paths under generated/reference directories are filtered out.',
        execute: (input, context) => runWorkspaceGlob(guard, options, input, context.toolCallId, context.toolName),
        toModelOutput: formatGlobModelOutput,
    };
}

async function runWorkspaceGlob(
    guard: WorkspaceGuard,
    options: GlobToolFactoryOptions,
    input: GlobToolInput,
    toolCallId: string,
    toolName: string,
): Promise<GlobToolOutput> {
    await requireReadPermission(options, toolCallId, toolName, input.path ?? '.');
    const base = await resolveGlobBase(guard, input.path);
    const matcher = globToRegExp(input.pattern);
    const rawEntries = await safeReaddirRecursive(base);
    const max = input.maxResults ?? 100;
    const matches: string[] = [];
    for (const absoluteEntry of rawEntries) {
        if (guard.isDeniedAbsolutePath(absoluteEntry)) {
            continue;
        }
        if (!(await isRealpathInsideWorkspace(guard, absoluteEntry))) {
            continue;
        }
        const rel = relative(base, absoluteEntry).split(sep).join('/');
        if (rel === '' || rel.startsWith('..')) {
            continue;
        }
        if (matcher.test(rel)) {
            matches.push(rel);
            if (matches.length >= max) {
                break;
            }
        }
    }
    matches.sort();
    return { paths: matches, truncated: matches.length >= max };
}

async function resolveGlobBase(guard: WorkspaceGuard, requestedPath: string | undefined): Promise<string> {
    if (requestedPath === undefined || requestedPath.length === 0) {
        return guard.root;
    }
    if (isAbsolute(requestedPath)) {
        throw repoToolFailure('workspace_escape', `glob base must be workspace-relative: ${requestedPath}`);
    }
    const lexical = resolve(guard.root, requestedPath);
    let physical: string;
    try {
        physical = await realpath(lexical);
    } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
            throw repoToolFailure('not_found', `glob base does not exist: ${requestedPath}`);
        }
        throw repoToolFailure('read_failed', errorMessage(error));
    }
    const rel = relative(guard.root, physical);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw repoToolFailure('workspace_escape', `glob base escapes workspace: ${requestedPath}`);
    }
    if (guard.isDeniedAbsolutePath(physical)) {
        throw repoToolFailure('workspace_denied', `glob base is denied by workspace policy: ${requestedPath}`);
    }
    return physical;
}

async function isRealpathInsideWorkspace(guard: WorkspaceGuard, absolutePath: string): Promise<boolean> {
    let physical: string;
    try {
        physical = await realpath(absolutePath);
    } catch {
        return false;
    }
    const rel = relative(guard.root, physical);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function requireReadPermission(
    options: GlobToolFactoryOptions,
    toolCallId: string,
    action: string,
    path: string,
): Promise<void> {
    if (options.requestPermission === undefined) {
        return;
    }
    const decision = await requestToolPermission(
        options.requestPermission,
        permissionRequest({
            toolCallId,
            action,
            reason: `${action} within workspace: ${path}`,
            permission: 'read',
            patterns: [path],
            workspaceRoot: options.workspaceRoot,
        }),
    );
    if (decision.status === 'allow') {
        return;
    }
    throw repoToolFailure(
        'read_failed',
        `${decision.status === 'deny' ? 'permission_denied' : 'approval_required'}: ${
            decision.reason ?? `${action} denied`
        }`,
    );
}

function isNodeError(error: unknown, code: string): error is { readonly code: string } {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
