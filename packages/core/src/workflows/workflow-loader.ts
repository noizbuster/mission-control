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
 * Broken workflows produce diagnostics, never throws. The automated-discovery
 * denylist retains reference-repository and generated-directory guards.
 */
import { type WorkflowDiscoveryDiagnostic, type WorkflowSpec, WorkflowSpecSchema } from '@mission-control/protocol';
import { absolutePathMatchesDenylist, resolveUserConfigDir } from '../discovery/index';
import { walkResourceFiles } from '../discovery/resource-walker';
import { errorToString } from '../util/error-to-string';
import { stripJsoncComments } from './jsonc-parser';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const DEFAULT_MAX_WORKFLOW_FILE_BYTES = 64 * 1024;
export const DEFAULT_MAX_WORKFLOWS = 256;
const WORKFLOW_FILE_SUFFIX_JSON = '.workflow.json';
const WORKFLOW_FILE_SUFFIX_JSONC = '.workflow.jsonc';

export type DiscoverWorkflowsOptions = {
    readonly workspaceRoot: string;
    readonly userConfigDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxWorkflowFileBytes?: number;
    readonly maxWorkflows?: number;
    /**
     * Additional directories to scan for `*.workflow.json(c)` files after the
     * three standard scopes. First-wins by name applies across all scopes.
     * Used to wire plugin-provided workflow directories.
     */
    readonly additionalWorkflowDirs?: readonly string[];
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
        const candidates = await walkResourceFiles(scope.dir, {
            matchesFile: (entry) => entry.isFile() && isWorkflowFile(entry.name),
        });
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
        return diagnostic(filePath, fallbackName, 'error', 'read_failed', `read failed: ${errorToString(error)}`);
    }
    const stripped = stripJsoncComments(contents);
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped);
    } catch (error: unknown) {
        return diagnostic(filePath, fallbackName, 'error', 'parse_error', `JSON parse failed: ${errorToString(error)}`);
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
    for (const dir of options.additionalWorkflowDirs ?? []) {
        scopes.push({ dir, skipped: false });
    }
    return scopes;
}

function isWorkflowFile(name: string): boolean {
    return name.endsWith(WORKFLOW_FILE_SUFFIX_JSON) || name.endsWith(WORKFLOW_FILE_SUFFIX_JSONC);
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
