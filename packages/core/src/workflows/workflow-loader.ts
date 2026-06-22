/**
 * Workflow discovery: `*.workflow.json(c)` files across 3 scopes, first-wins by
 * name. Mirrors `discoverSkills` (3-scope walk, denylist, symlink defense, size
 * bound, never-throws).
 *
 * Scope priority (first-wins by name):
 *   1. global  `<user-config-dir>/workflows/`
 *   2. project `<workspace>/.mctrl/workflows/`
 *   3. project `<workspace>/.agents/workflows/`
 *
 * Broken workflows produce diagnostics, never throws. Denylist reuses the
 * read-tools denylist so `temp/ref-repos` / generated-dir guards apply.
 */
import { type WorkflowDiscoveryDiagnostic, type WorkflowSpec, WorkflowSpecSchema } from '@mission-control/protocol';
import { resolveUserConfigDir } from '../skills/skill-loader.js';
import { defaultReadOnlyRepoToolDenylist, toPosixPath } from '../tools/read-tools-paths.js';
import { stripJsoncComments } from './jsonc-parser.js';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const DEFAULT_MAX_WORKFLOW_FILE_BYTES = 64 * 1024;
export const DEFAULT_MAX_WORKFLOWS = 256;
const MAX_WALK_DEPTH = 10;
const WORKFLOW_FILE_SUFFIX_JSON = '.workflow.json';
const WORKFLOW_FILE_SUFFIX_JSONC = '.workflow.jsonc';

const denylistAbsolutePathNeedles: readonly string[] = defaultReadOnlyRepoToolDenylist.map((entry) =>
    entry.toLowerCase(),
);
const denylistDirNameSet: ReadonlySet<string> = new Set(
    defaultReadOnlyRepoToolDenylist.filter((entry) => !entry.includes('/')).map((entry) => entry.toLowerCase()),
);

export type DiscoverWorkflowsOptions = {
    readonly workspaceRoot: string;
    readonly userConfigDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxWorkflowFileBytes?: number;
    readonly maxWorkflows?: number;
};

export type DiscoverWorkflowsResult = {
    readonly workflows: readonly WorkflowSpec[];
    readonly diagnostics: readonly WorkflowDiscoveryDiagnostic[];
};

type ScopeDescriptor = {
    readonly dir: string;
    readonly skipped: boolean;
};

type FileLoadOutcome =
    | { readonly kind: 'loaded'; readonly spec: WorkflowSpec }
    | { readonly kind: 'diagnostic'; readonly diagnostic: WorkflowDiscoveryDiagnostic }
    | { readonly kind: 'drop' };

/**
 * Discover workflows across all scopes, first-wins by name in priority order.
 * Never throws: malformed files, oversized files, and duplicates produce
 * diagnostics and are skipped.
 */
export async function discoverWorkflows(options: DiscoverWorkflowsOptions): Promise<DiscoverWorkflowsResult> {
    const maxFileBytes = options.maxWorkflowFileBytes ?? DEFAULT_MAX_WORKFLOW_FILE_BYTES;
    const maxWorkflows = options.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS;
    const diagnostics: WorkflowDiscoveryDiagnostic[] = [];
    const workflows: WorkflowSpec[] = [];
    const seenNames = new Set<string>();
    const workspaceRootDenied = absolutePathMatchesDenylist(options.workspaceRoot);

    for (const scope of resolveWorkflowScopes(options, workspaceRootDenied)) {
        if (scope.skipped) {
            continue;
        }
        const candidates = await walkWorkflowFiles(scope.dir);
        for (const filePath of candidates) {
            const outcome = await tryLoadWorkflowFile(filePath, maxFileBytes);
            if (outcome.kind === 'diagnostic') {
                diagnostics.push(outcome.diagnostic);
                continue;
            }
            if (outcome.kind === 'drop') {
                continue;
            }
            const spec = outcome.spec;
            if (seenNames.has(spec.name)) {
                diagnostics.push({
                    workflowName: spec.name,
                    severity: 'warning',
                    code: 'duplicate_name',
                    message: `workflow '${spec.name}' already discovered (first-wins)`,
                    path: filePath,
                });
                continue;
            }
            if (workflows.length >= maxWorkflows) {
                diagnostics.push({
                    workflowName: spec.name,
                    severity: 'warning',
                    code: 'limit_reached',
                    message: `max workflows limit (${maxWorkflows}) reached`,
                    path: filePath,
                });
                continue;
            }
            seenNames.add(spec.name);
            workflows.push(spec);
        }
    }

    return { workflows, diagnostics };
}

async function tryLoadWorkflowFile(filePath: string, maxFileBytes: number): Promise<FileLoadOutcome> {
    const fallbackName = deriveWorkflowName(filePath);
    if (absolutePathMatchesDenylist(filePath)) {
        return diagnostic(filePath, fallbackName, 'warning', 'denylisted', 'path matches the discovery denylist');
    }
    let fileStats: { readonly size: number };
    try {
        fileStats = await stat(filePath);
    } catch {
        return { kind: 'drop' };
    }
    if (fileStats.size > maxFileBytes) {
        return diagnostic(
            filePath,
            fallbackName,
            'warning',
            'size_exceeded',
            `file exceeds size bound (${fileStats.size} > ${maxFileBytes} bytes)`,
        );
    }
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        return diagnostic(filePath, fallbackName, 'error', 'read_failed', `read failed: ${instanceMessage(error)}`);
    }
    const stripped = stripJsoncComments(contents);
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped);
    } catch (error: unknown) {
        return diagnostic(
            filePath,
            fallbackName,
            'error',
            'parse_error',
            `JSON parse failed: ${instanceMessage(error)}`,
        );
    }
    const result = WorkflowSpecSchema.safeParse(parsed);
    if (!result.success) {
        const name = readNameField(parsed, fallbackName);
        const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        return diagnostic(filePath, name, 'error', 'validation_error', `schema validation failed: ${issues}`);
    }
    return { kind: 'loaded', spec: result.data };
}

function diagnostic(
    filePath: string,
    workflowName: string,
    severity: 'error' | 'warning',
    code: string,
    message: string,
): FileLoadOutcome {
    return {
        kind: 'diagnostic',
        diagnostic: { workflowName, severity, code, message, path: filePath },
    };
}

function resolveWorkflowScopes(
    options: DiscoverWorkflowsOptions,
    workspaceRootDenied: boolean,
): readonly ScopeDescriptor[] {
    const scopes: ScopeDescriptor[] = [];
    const globalDir = join(
        resolveUserConfigDir({
            ...(options.userConfigDir !== undefined ? { userConfigDir: options.userConfigDir } : {}),
            ...(options.env !== undefined ? { env: options.env } : {}),
        }),
        'workflows',
    );
    scopes.push({ dir: globalDir, skipped: false });
    if (workspaceRootDenied) {
        scopes.push({ dir: join(options.workspaceRoot, '.mctrl', 'workflows'), skipped: true });
        scopes.push({ dir: join(options.workspaceRoot, '.agents', 'workflows'), skipped: true });
    } else {
        scopes.push({ dir: join(options.workspaceRoot, '.mctrl', 'workflows'), skipped: false });
        scopes.push({ dir: join(options.workspaceRoot, '.agents', 'workflows'), skipped: false });
    }
    return scopes;
}

async function walkWorkflowFiles(scopeRoot: string): Promise<readonly string[]> {
    const results: string[] = [];
    const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: scopeRoot, depth: 0 }];
    while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined || item.depth > MAX_WALK_DEPTH) {
            continue;
        }
        let entries: readonly Dirent[];
        try {
            entries = await readdir(item.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const fullPath = join(item.dir, entry.name);
            if (entry.isDirectory()) {
                if (denylistDirNameSet.has(entry.name.toLowerCase())) {
                    continue;
                }
                queue.push({ dir: fullPath, depth: item.depth + 1 });
                continue;
            }
            if (entry.isFile() && isWorkflowFile(entry.name)) {
                results.push(fullPath);
            }
        }
    }
    return results.sort();
}

function isWorkflowFile(name: string): boolean {
    return name.endsWith(WORKFLOW_FILE_SUFFIX_JSON) || name.endsWith(WORKFLOW_FILE_SUFFIX_JSONC);
}

function absolutePathMatchesDenylist(absolutePath: string): boolean {
    const posix = toPosixPath(absolutePath).toLowerCase();
    return denylistAbsolutePathNeedles.some((needle) => {
        if (needle.length === 0) {
            return false;
        }
        return posix === needle || posix.includes(`/${needle}/`) || posix.endsWith(`/${needle}`);
    });
}

function deriveWorkflowName(filePath: string): string {
    const base = basename(filePath);
    const stripped = base.replace(/\.workflow\.jsonc?$/u, '');
    return stripped.length > 0 ? stripped : base;
}

function readNameField(value: unknown, fallback: string): string {
    if (typeof value === 'object' && value !== null && 'name' in value) {
        const candidate = (value as { readonly name?: unknown }).name;
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return fallback;
}

function instanceMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
